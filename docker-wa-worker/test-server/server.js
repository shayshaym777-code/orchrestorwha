const express = require('express');
const chalk = require('chalk');
const QRCode = require('qrcode');

const app = express();
const PORT = 3000;

// Store events for inspection
const events = [];

app.use(express.json());

// Webhook endpoint
app.post('/webhook', (req, res) => {
  const { sessionId, type, timestamp, data } = req.body;
  const time = new Date(timestamp).toLocaleTimeString('he-IL');
  
  // Store event
  events.push({ sessionId, type, timestamp, data, receivedAt: Date.now() });
  
  // Pretty print based on event type
  console.log('\n' + '='.repeat(60));
  
  switch (type) {
    case 'QR_UPDATE':
      console.log(chalk.yellow.bold(`📱 [${time}] QR_UPDATE - Session: ${sessionId}`));
      console.log(chalk.gray(`   QR Code: ${data.qrCode?.substring(0, 50)}...`));
      console.log(chalk.cyan(`   👉 Scan this QR with WhatsApp!`));
      break;
      
    case 'CONNECTED':
      console.log(chalk.green.bold(`✅ [${time}] CONNECTED - Session: ${sessionId}`));
      console.log(chalk.white(`   Phone: ${data.phoneNumber}`));
      console.log(chalk.white(`   JID: ${data.jid}`));
      break;
      
    case 'STATUS_CHANGE':
      const status = data.status;
      if (status === 'LOGGED_OUT') {
        console.log(chalk.red.bold(`🚫 [${time}] LOGGED_OUT - Session: ${sessionId}`));
      } else if (status === 'RECONNECTING') {
        console.log(chalk.yellow(`🔄 [${time}] RECONNECTING - Session: ${sessionId}`));
      } else if (status === 'SHUTTING_DOWN') {
        console.log(chalk.gray(`⏹️  [${time}] SHUTTING_DOWN - Session: ${sessionId}`));
      } else {
        console.log(chalk.blue(`ℹ️  [${time}] STATUS: ${status} - Session: ${sessionId}`));
      }
      break;
      
    case 'PING':
      console.log(chalk.gray(`💓 [${time}] PING - Session: ${sessionId} - ${data.status}`));
      break;
      
    default:
      console.log(chalk.white(`❓ [${time}] ${type} - Session: ${sessionId}`));
      console.log(chalk.gray(`   Data: ${JSON.stringify(data)}`));
  }
  
  res.json({ received: true, eventCount: events.length });
});

// Get all events (for debugging)
app.get('/events', (req, res) => {
  res.json(events);
});

// Get events by session
app.get('/events/:sessionId', (req, res) => {
  const sessionEvents = events.filter(e => e.sessionId === req.params.sessionId);
  res.json(sessionEvents);
});

// Clear events
app.delete('/events', (req, res) => {
  events.length = 0;
  console.log(chalk.magenta('\n🗑️  Events cleared'));
  res.json({ cleared: true });
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', eventCount: events.length });
});

// QR display endpoint (shows last QR for a session)
app.get('/qr/:sessionId', async (req, res) => {
  const qrEvents = events
    .filter(e => e.sessionId === req.params.sessionId && e.type === 'QR_UPDATE')
    .reverse();
  
  if (qrEvents.length === 0) {
    return res.send('<h1>No QR code yet for session ' + req.params.sessionId + '</h1><p>Refresh this page after starting the worker.</p><meta http-equiv="refresh" content="3">');
  }
  
  const lastQR = qrEvents[0].data.qrCode;
  
  // Generate QR code as data URL server-side
  let qrDataUrl;
  try {
    qrDataUrl = await QRCode.toDataURL(lastQR, { 
      width: 300,
      margin: 2,
      color: { dark: '#000000', light: '#ffffff' }
    });
  } catch (err) {
    return res.send('<h1>Error generating QR</h1><p>' + err.message + '</p>');
  }
  
  // Generate QR HTML page with server-generated image
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>WhatsApp QR - Session ${req.params.sessionId}</title>
      <meta http-equiv="refresh" content="20">
      <style>
        body { 
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          display: flex; 
          flex-direction: column; 
          align-items: center; 
          justify-content: center; 
          min-height: 100vh;
          margin: 0;
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          color: white;
        }
        h1 { margin-bottom: 10px; }
        p { margin: 5px 0; opacity: 0.8; }
        .qr-container { 
          background: white; 
          padding: 20px; 
          border-radius: 16px;
          box-shadow: 0 20px 60px rgba(0,0,0,0.3);
          margin: 20px 0;
        }
        .qr-container img {
          display: block;
        }
        .refresh { 
          background: rgba(255,255,255,0.2); 
          border: none; 
          padding: 12px 24px; 
          border-radius: 8px;
          color: white;
          cursor: pointer;
          font-size: 16px;
        }
        .refresh:hover { background: rgba(255,255,255,0.3); }
        .auto-refresh { font-size: 12px; opacity: 0.6; margin-top: 10px; }
      </style>
    </head>
    <body>
      <h1>📱 WhatsApp QR Code</h1>
      <p>Session: ${req.params.sessionId}</p>
      <div class="qr-container">
        <img src="${qrDataUrl}" alt="QR Code" width="300" height="300">
      </div>
      <p>Scan with WhatsApp to connect</p>
      <button class="refresh" onclick="location.reload()">🔄 Refresh</button>
      <p class="auto-refresh">Auto-refreshes every 20 seconds</p>
    </body>
    </html>
  `);
});

// Dashboard
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>WhatsApp Worker Test Dashboard</title>
      <style>
        body { 
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          max-width: 800px; 
          margin: 40px auto; 
          padding: 20px;
          background: #1a1a2e;
          color: #eee;
        }
        h1 { color: #00d9ff; }
        .card {
          background: #16213e;
          padding: 20px;
          border-radius: 12px;
          margin: 20px 0;
        }
        a { color: #00d9ff; }
        code { 
          background: #0f0f23; 
          padding: 2px 8px; 
          border-radius: 4px;
          color: #25d366;
        }
        pre {
          background: #0f0f23;
          padding: 16px;
          border-radius: 8px;
          overflow-x: auto;
        }
      </style>
    </head>
    <body>
      <h1>🧪 WhatsApp Worker Test Server</h1>
      
      <div class="card">
        <h2>📊 Status</h2>
        <p>Events received: <strong>${events.length}</strong></p>
        <p>Server running on port: <strong>${PORT}</strong></p>
      </div>
      
      <div class="card">
        <h2>🔗 Endpoints</h2>
        <ul>
          <li><code>POST /webhook</code> - Receive worker events</li>
          <li><code>GET /events</code> - <a href="/events">View all events</a></li>
          <li><code>GET /qr/:sessionId</code> - View QR code (e.g., <a href="/qr/123">/qr/123</a>)</li>
          <li><code>DELETE /events</code> - Clear events</li>
        </ul>
      </div>
      
      <div class="card">
        <h2>🚀 Quick Start</h2>
        <p>Run a worker with:</p>
        <pre>docker run -d --name wa_test \\
  -v C:\\wa-sessions\\123:/app/sessions/123 \\
  -e SESSION_ID="123" \\
  -e WEBHOOK_URL="http://host.docker.internal:3000/webhook" \\
  whatsapp-worker-image:local</pre>
        <p>Then view QR at: <a href="/qr/123">/qr/123</a></p>
      </div>
    </body>
    </html>
  `);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(chalk.cyan.bold('\n' + '='.repeat(60)));
  console.log(chalk.cyan.bold('  🧪 WhatsApp Worker Test Server'));
  console.log(chalk.cyan.bold('='.repeat(60)));
  console.log(chalk.white(`\n  📡 Webhook endpoint: http://localhost:${PORT}/webhook`));
  console.log(chalk.white(`  🖥️  Dashboard: http://localhost:${PORT}/`));
  console.log(chalk.white(`  📱 QR viewer: http://localhost:${PORT}/qr/{sessionId}`));
  console.log(chalk.gray(`\n  Waiting for events...\n`));
});

