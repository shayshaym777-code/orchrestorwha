/**
 * Backup Service
 * Backs up session data to local storage
 * Can be extended to support S3/Google Cloud
 */

const fs = require("fs-extra");
const path = require("path");
const { exec } = require("child_process");
const { promisify } = require("util");
const archiver = require("archiver");
const execAsync = promisify(exec);

const SESSIONS_DIR = process.env.SESSIONS_DIR || "./sessions";
const BACKUPS_DIR = process.env.BACKUPS_DIR || "./backups";
const MAX_BACKUPS = parseInt(process.env.MAX_BACKUPS || "7");

/**
 * Create backup of all sessions
 */
async function createBackup() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const date = new Date().toISOString().split("T")[0];
  const backupName = `sessions_backup_${date}_${timestamp}`;
  const archivePath = path.join(BACKUPS_DIR, `${backupName}.zip`);
  
  console.log(`[Backup] Starting backup: ${backupName}`);
  
  try {
    // Ensure directories exist
    await fs.ensureDir(BACKUPS_DIR);
    
    if (!await fs.pathExists(SESSIONS_DIR)) {
      console.log("[Backup] Sessions directory doesn't exist, nothing to backup");
      return { success: false, reason: "NO_SESSIONS_DIR" };
    }
    
    // Count sessions
    const sessionDirs = await fs.readdir(SESSIONS_DIR);
    const sessions = sessionDirs.filter(d => !d.startsWith("."));
    
    if (sessions.length === 0) {
      console.log("[Backup] No sessions to backup");
      return { success: false, reason: "NO_SESSIONS" };
    }
    
    // Create zip archive
    const output = fs.createWriteStream(archivePath);
    const archive = archiver("zip", { zlib: { level: 9 } });
    
    return new Promise((resolve, reject) => {
      output.on("close", async () => {
        const stats = await fs.stat(archivePath);
        const sizeMB = (stats.size / 1024 / 1024).toFixed(2);
        
        console.log(`[Backup] ✅ Created: ${archivePath} (${sizeMB} MB, ${sessions.length} sessions)`);
        
        // Clean old backups
        const cleanup = await cleanOldBackups();
        
        resolve({
          success: true,
          path: archivePath,
          name: `${backupName}.zip`,
          size: stats.size,
          sizeMB,
          sessionsCount: sessions.length,
          timestamp: new Date().toISOString(),
          cleanup
        });
      });
      
      output.on("error", (err) => {
        console.error("[Backup] Output error:", err.message);
        reject(err);
      });
      
      archive.on("error", (err) => {
        console.error("[Backup] Archive error:", err.message);
        reject(err);
      });
      
      archive.on("warning", (err) => {
        console.warn("[Backup] Warning:", err.message);
      });
      
      archive.pipe(output);
      
      // Add sessions directory (excluding lock files)
      archive.directory(SESSIONS_DIR, "sessions", (entry) => {
        // Exclude lock files and temp files
        if (entry.name.includes(".lock") || entry.name.startsWith(".")) {
          return false;
        }
        return entry;
      });
      
      archive.finalize();
    });
    
  } catch (error) {
    console.error("[Backup] ❌ Failed:", error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Clean old backups (keep last N)
 */
async function cleanOldBackups() {
  try {
    await fs.ensureDir(BACKUPS_DIR);
    const files = await fs.readdir(BACKUPS_DIR);
    
    const backups = files
      .filter(f => f.startsWith("sessions_backup_") && (f.endsWith(".zip") || f.endsWith(".tar.gz")))
      .map(f => ({
        name: f,
        path: path.join(BACKUPS_DIR, f)
      }));
    
    // Sort by filename (which includes date)
    backups.sort((a, b) => b.name.localeCompare(a.name));
    
    // Remove old backups
    const toDelete = backups.slice(MAX_BACKUPS);
    let deleted = 0;
    
    for (const backup of toDelete) {
      try {
        await fs.remove(backup.path);
        console.log(`[Backup] 🗑️ Deleted old backup: ${backup.name}`);
        deleted++;
      } catch (err) {
        console.error(`[Backup] Failed to delete ${backup.name}:`, err.message);
      }
    }
    
    return { 
      kept: Math.min(backups.length, MAX_BACKUPS), 
      deleted,
      maxBackups: MAX_BACKUPS
    };
  } catch (error) {
    console.error("[Backup] Cleanup error:", error.message);
    return { error: error.message };
  }
}

/**
 * Restore session from backup
 */
async function restoreBackup(backupFile, sessionId = null) {
  const backupPath = path.join(BACKUPS_DIR, backupFile);
  
  if (!await fs.pathExists(backupPath)) {
    return { success: false, error: "Backup file not found" };
  }
  
  console.log(`[Backup] Restoring from: ${backupFile}${sessionId ? ` (session: ${sessionId})` : ""}`);
  
  const tempDir = path.join(BACKUPS_DIR, `_restore_temp_${Date.now()}`);
  
  try {
    await fs.ensureDir(tempDir);
    
    // Extract based on file type
    if (backupFile.endsWith(".zip")) {
      const extract = require("extract-zip");
      await extract(backupPath, { dir: tempDir });
    } else if (backupFile.endsWith(".tar.gz")) {
      await execAsync(`tar -xzf "${backupPath}" -C "${tempDir}"`);
    } else {
      await fs.remove(tempDir);
      return { success: false, error: "Unsupported backup format" };
    }
    
    // Find sessions folder
    let sessionsPath = tempDir;
    const contents = await fs.readdir(tempDir);
    
    if (contents.includes("sessions")) {
      sessionsPath = path.join(tempDir, "sessions");
    } else if (contents.length === 1) {
      const subdir = path.join(tempDir, contents[0]);
      const stat = await fs.stat(subdir);
      if (stat.isDirectory()) {
        sessionsPath = subdir;
        if (await fs.pathExists(path.join(sessionsPath, "sessions"))) {
          sessionsPath = path.join(sessionsPath, "sessions");
        }
      }
    }
    
    if (sessionId) {
      // Restore specific session
      const sessionBackup = path.join(sessionsPath, sessionId);
      
      if (!await fs.pathExists(sessionBackup)) {
        const available = await fs.readdir(sessionsPath);
        await fs.remove(tempDir);
        return { 
          success: false, 
          error: `Session ${sessionId} not found in backup`,
          availableSessions: available.filter(d => !d.startsWith("."))
        };
      }
      
      const sessionDest = path.join(SESSIONS_DIR, sessionId);
      
      // Backup existing session if exists
      if (await fs.pathExists(sessionDest)) {
        const backupExisting = `${sessionDest}_pre_restore_${Date.now()}`;
        await fs.move(sessionDest, backupExisting);
        console.log(`[Backup] Backed up existing session to: ${backupExisting}`);
      }
      
      await fs.copy(sessionBackup, sessionDest);
      console.log(`[Backup] ✅ Restored session: ${sessionId}`);
      
    } else {
      // Restore all sessions
      const sessions = await fs.readdir(sessionsPath);
      let restored = 0;
      
      for (const session of sessions) {
        if (session.startsWith(".")) continue;
        
        const src = path.join(sessionsPath, session);
        const dest = path.join(SESSIONS_DIR, session);
        
        const stat = await fs.stat(src);
        if (!stat.isDirectory()) continue;
        
        await fs.copy(src, dest, { overwrite: true });
        restored++;
      }
      
      console.log(`[Backup] ✅ Restored ${restored} sessions`);
    }
    
    // Cleanup temp
    await fs.remove(tempDir);
    
    return { 
      success: true, 
      restored: sessionId || "all",
      timestamp: new Date().toISOString()
    };
    
  } catch (error) {
    console.error("[Backup] ❌ Restore failed:", error.message);
    
    // Cleanup temp on error
    try {
      await fs.remove(tempDir);
    } catch (e) {}
    
    return { success: false, error: error.message };
  }
}

/**
 * List available backups
 */
async function listBackups() {
  try {
    await fs.ensureDir(BACKUPS_DIR);
    const files = await fs.readdir(BACKUPS_DIR);
    
    const backups = [];
    for (const f of files) {
      if (!f.startsWith("sessions_backup_")) continue;
      if (!f.endsWith(".zip") && !f.endsWith(".tar.gz")) continue;
      
      const filePath = path.join(BACKUPS_DIR, f);
      
      try {
        const stats = await fs.stat(filePath);
        
        // Extract date from filename
        const dateMatch = f.match(/sessions_backup_(\d{4}-\d{2}-\d{2})/);
        const date = dateMatch ? dateMatch[1] : "";
        
        backups.push({
          name: f,
          date,
          size: stats.size,
          sizeMB: (stats.size / 1024 / 1024).toFixed(2),
          created: stats.mtime.toISOString()
        });
      } catch (err) {
        // Skip files we can't stat
      }
    }
    
    // Sort by date descending
    return backups.sort((a, b) => b.date.localeCompare(a.date));
    
  } catch (error) {
    console.error("[Backup] List error:", error.message);
    return [];
  }
}

/**
 * Get backup config/status
 */
async function getBackupStatus() {
  const backups = await listBackups();
  const lastBackup = backups[0] || null;
  
  let sessionsDir = { exists: false, sessions: 0 };
  try {
    if (await fs.pathExists(SESSIONS_DIR)) {
      const dirs = await fs.readdir(SESSIONS_DIR);
      sessionsDir = {
        exists: true,
        sessions: dirs.filter(d => !d.startsWith(".")).length
      };
    }
  } catch (e) {}
  
  return {
    sessionsDir: SESSIONS_DIR,
    backupsDir: BACKUPS_DIR,
    maxBackups: MAX_BACKUPS,
    totalBackups: backups.length,
    lastBackup: lastBackup ? {
      name: lastBackup.name,
      date: lastBackup.date,
      sizeMB: lastBackup.sizeMB
    } : null,
    sessionsToBackup: sessionsDir.sessions
  };
}

/**
 * Delete a specific backup
 */
async function deleteBackup(backupName) {
  const backupPath = path.join(BACKUPS_DIR, backupName);
  
  if (!await fs.pathExists(backupPath)) {
    return { success: false, error: "Backup not found" };
  }
  
  // Security check - must be a backup file
  if (!backupName.startsWith("sessions_backup_")) {
    return { success: false, error: "Invalid backup name" };
  }
  
  try {
    await fs.remove(backupPath);
    console.log(`[Backup] 🗑️ Deleted: ${backupName}`);
    return { success: true, deleted: backupName };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

module.exports = {
  createBackup,
  cleanOldBackups,
  restoreBackup,
  listBackups,
  getBackupStatus,
  deleteBackup
};

