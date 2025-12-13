const multer = require("multer");

const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10MB

function fileFilter(_req, file, cb) {
  const allowed = ["image/jpeg", "image/png", "image/webp"];
  if (!allowed.includes(file.mimetype)) {
    const err = new Error("Invalid image type");
    err.statusCode = 400;
    return cb(err);
  }
  return cb(null, true);
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_IMAGE_BYTES },
  fileFilter
});

module.exports = { upload };


