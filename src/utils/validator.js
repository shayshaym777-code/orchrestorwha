function badRequest(message) {
  const err = new Error(message || "Invalid payload");
  err.statusCode = 400;
  return err;
}

function isPlainObject(x) {
  return Boolean(x) && typeof x === "object" && !Array.isArray(x);
}

function validatePhone(phone) {
  if (typeof phone !== "string") return false;
  // Allow only digits (E.164 without '+'), typical range 8-15 digits.
  if (!/^\d{8,15}$/.test(phone)) return false;
  return true;
}

function parseAndValidateIncomingPayload({ dataField, file }) {
  if (typeof dataField !== "string" || dataField.trim().length === 0) {
    throw badRequest("Invalid payload");
  }

  let data;
  try {
    data = JSON.parse(dataField);
  } catch {
    throw badRequest("Invalid payload");
  }

  if (!isPlainObject(data)) throw badRequest("Invalid payload");

  const message = data.message;
  const contacts = data.contacts;

  if (!Array.isArray(contacts) || contacts.length === 0) {
    throw badRequest("Invalid payload");
  }

  const hasImage = Boolean(file);
  const hasMessage = typeof message === "string" && message.trim().length > 0;

  // Spec update: either (image) OR (message + contacts). Not both.
  // - If image exists: message must be empty/missing.
  // - If no image: message is required.
  if (hasImage && hasMessage) throw badRequest("Invalid payload");
  if (!hasImage && !hasMessage) throw badRequest("Invalid payload");

  const normalizedContacts = contacts.map((c) => {
    if (!isPlainObject(c)) throw badRequest("Invalid payload");

    const name = c.name;
    const phone = c.phone;

    if (typeof name !== "string" || name.trim().length === 0) {
      throw badRequest("Invalid payload");
    }
    if (!validatePhone(phone)) {
      throw badRequest("Invalid payload");
    }

    return { name: name.trim(), phone };
  });

  let image = null;
  if (file) {
    image = {
      originalName: file.originalname,
      mimeType: file.mimetype,
      size: file.size,
      buffer: file.buffer
    };
  }

  return {
    message: hasMessage ? message.trim() : null,
    contacts: normalizedContacts,
    image
  };
}

module.exports = { parseAndValidateIncomingPayload };


