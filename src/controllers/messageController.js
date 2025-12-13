const { parseAndValidateIncomingPayload } = require("../utils/validator");
const { intakeMessage } = require("../services/messageService");

async function handleIncomingMessage(req, res, next) {
  try {
    const parsed = parseAndValidateIncomingPayload({
      dataField: req.body?.data,
      file: req.file || null
    });

    await intakeMessage(parsed);

    return res.status(200).json({
      status: "ok",
      received: parsed.contacts.length,
      hasImage: Boolean(parsed.image)
    });
  } catch (err) {
    return next(err);
  }
}

module.exports = { handleIncomingMessage };


