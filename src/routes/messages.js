const express = require("express");

const { requireApiKey } = require("../middlewares/requireApiKey");
const { upload } = require("../middlewares/upload");
const { handleIncomingMessage } = require("../controllers/messageController");

const router = express.Router();

// POST /api/messages
router.post("/", requireApiKey, upload.single("image"), handleIncomingMessage);

module.exports = router;


