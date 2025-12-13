/**
 * GATEWAY_SPEC.md Validators
 * 
 * Strict validation per spec:
 * - contacts: array with name/phone
 * - message OR image (not both)
 * - idempotencyKey: optional, strict format
 */

const Joi = require("joi");

// ===========================================
// VALIDATION RULES (GATEWAY_SPEC.md strict)
// ===========================================

// Phone: digits only, 8-15 chars (E.164 without +)
const phonePattern = /^[0-9]{8,15}$/;

// idempotencyKey: 1-128 chars, [A-Za-z0-9._-]
const idempotencyKeyPattern = /^[A-Za-z0-9._-]{1,128}$/;

// ===========================================
// JSON MODE (message)
// ===========================================

const jsonModeSchema = Joi.object({
  idempotencyKey: Joi.string().pattern(idempotencyKeyPattern).optional()
    .messages({
      "string.pattern.base": "idempotencyKey must be 1-128 chars of [A-Za-z0-9._-]"
    }),
  message: Joi.string().trim().min(1).max(4096).required()
    .messages({
      "string.empty": "Message cannot be empty",
      "string.max": "Message cannot exceed 4096 characters",
      "any.required": "Message is required"
    }),
  contacts: Joi.array().items(Joi.object({
    name: Joi.string().trim().min(1).max(80).required()
      .messages({
        "string.empty": "Contact name cannot be empty",
        "string.max": "Contact name cannot exceed 80 characters",
        "any.required": "Contact name is required"
      }),
    phone: Joi.string().pattern(phonePattern).required()
      .messages({
        "string.pattern.base": "Phone must be 8-15 digits only (no + or spaces)",
        "any.required": "Contact phone is required"
      })
  })).min(1).required()
    .messages({
      "array.min": "At least one contact is required",
      "any.required": "Contacts array is required"
    })
}).strict().messages({
  "object.unknown": "Unknown field: {#label}"
});

// ===========================================
// MULTIPART MODE (image + contacts string)
// ===========================================

/**
 * Validate multipart fields (after parsing)
 * @param {Object} fields - { idempotencyKey?, contacts }
 * @param {Object} file - multer file object
 */
function validateMultipartMode(fields, file) {
  const errors = [];
  
  // 1. Check file exists
  if (!file) {
    return {
      valid: false,
      code: "PAYLOAD_INVALID",
      reason: "Image file is required in image mode"
    };
  }
  
  // 2. Validate file type
  const allowedTypes = ["image/jpeg", "image/png", "image/webp"];
  if (!allowedTypes.includes(file.mimetype)) {
    return {
      valid: false,
      code: "UNSUPPORTED_MEDIA_TYPE",
      reason: `Image type ${file.mimetype} not supported. Allowed: jpeg, png, webp`,
      statusCode: 415
    };
  }
  
  // 3. Validate file size (10MB)
  const maxSize = 10 * 1024 * 1024;
  if (file.size > maxSize) {
    return {
      valid: false,
      code: "FILE_TOO_LARGE",
      reason: `Image size ${file.size} exceeds limit of 10MB`,
      statusCode: 413
    };
  }
  
  // 4. Validate contacts (must be JSON array string)
  if (!fields.contacts) {
    return {
      valid: false,
      code: "PAYLOAD_INVALID",
      reason: "contacts field is required"
    };
  }
  
  let contactsArray;
  try {
    contactsArray = JSON.parse(fields.contacts);
  } catch (e) {
    return {
      valid: false,
      code: "PAYLOAD_INVALID",
      reason: "contacts must be valid JSON array"
    };
  }
  
  if (!Array.isArray(contactsArray)) {
    return {
      valid: false,
      code: "PAYLOAD_INVALID",
      reason: "contacts must be an array"
    };
  }
  
  // Validate contacts array with Joi
  const contactsSchema = Joi.array().items(Joi.object({
    name: Joi.string().trim().min(1).max(80).required()
      .messages({
        "string.empty": "Contact name cannot be empty",
        "string.max": "Contact name cannot exceed 80 characters",
        "any.required": "Contact name is required"
      }),
    phone: Joi.string().pattern(phonePattern).required()
      .messages({
        "string.pattern.base": "Phone must be 8-15 digits only (no + or spaces)",
        "any.required": "Contact phone is required"
      })
  })).min(1).required();
  const { error, value } = contactsSchema.validate(contactsArray);
  
  if (error) {
    return {
      valid: false,
      code: "PAYLOAD_INVALID",
      reason: error.details[0].message
    };
  }
  
  // 5. Validate idempotencyKey if present
  if (fields.idempotencyKey) {
    if (!idempotencyKeyPattern.test(fields.idempotencyKey)) {
      return {
        valid: false,
        code: "PAYLOAD_INVALID",
        reason: "idempotencyKey must be 1-128 chars of [A-Za-z0-9._-]"
      };
    }
  }
  
  // 6. No "message" field in image mode
  if (fields.message) {
    return {
      valid: false,
      code: "PAYLOAD_INVALID",
      reason: "Cannot send both message and image"
    };
  }
  
  return {
    valid: true,
    data: {
      idempotencyKey: fields.idempotencyKey,
      contacts: value,
      image: file
    }
  };
}

// ===========================================
// EXPORTS
// ===========================================

module.exports = {
  jsonModeSchema,
  validateMultipartMode,
  phonePattern,
  idempotencyKeyPattern
};
