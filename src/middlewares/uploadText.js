const multer = require("multer");

const MAX_TEXT_BYTES = 5 * 1024 * 1024; // 5MB

function fileFilter(_req, file, cb) {
  // Accept text files and generic octet-stream (some clients send this).
  const allowed = ["text/plain", "application/octet-stream"];
  if (!allowed.includes(file.mimetype)) {
    const err = new Error("Invalid file type");
    err.statusCode = 400;
    return cb(err);
  }
  return cb(null, true);
}

const uploadText = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_TEXT_BYTES },
  fileFilter
});

module.exports = { uploadText };


