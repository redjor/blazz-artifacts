// API errors: a stable machine `code` plus an English message. The admin SPA maps each code to
// localised text (web/src/i18n) and falls back to the message. `{name}` placeholders are filled from `params`.
export const ERRORS = {
  font_unavailable: 'The selected font could not be downloaded. Please try again.',
  invalid_theme: 'Invalid theme: check text, colors, layout and embedded raster logo',
  theme_not_found: 'Theme not found',
  theme_markdown_only: 'Themes can only be applied to Markdown documents',
  version_changed: 'The current version changed: preview again before applying',

  payload_too_large: 'Request too large',
  too_many_attempts: 'Too many attempts. Try again in 15 minutes.',
  wrong_password: 'Incorrect password',
  token_not_allowed: 'Not available with an API token',
  unknown_route: 'Unknown route',
  internal: 'Internal error',
  token_disabled: 'API token disabled',
  token_invalid: 'Invalid API token',
  origin_refused: 'Origin refused',
  session_required: 'Session required',
  csrf_invalid: 'Invalid CSRF token',
  invalid_visibility: 'Invalid visibility',
  invalid_title: 'Title must be between 1 and 120 characters',
  invalid_hours: 'Duration must be between 1 and 8760 hours',
  invalid_days: 'days must be an integer between 1 and 365',
  invalid_code: 'Code must be between 6 and 128 characters',
  invalid_project: 'Invalid project: letters, digits and hyphens, 32 characters max',
  invalid_folder_title: 'Invalid title',
  folder_title_too_long: 'Title: {max} characters max',
  invalid_description: 'Invalid description',
  description_too_long: 'Description: {max} characters max',
  invalid_version_message: 'Invalid version note',
  version_message_too_long: 'Version note: {max} characters max',
  expiry_in_past: 'The expiry date must be in the future',
  invalid_tags_type: 'Invalid tags: a list of strings is expected',
  invalid_tags: 'Invalid tags: letters, digits and hyphens (32 characters max), 20 tags at most',
  artifact_not_found: 'Artifact not found',
  invalid_slug: 'Invalid slug: lowercase letters, digits and hyphens, 48 characters max',
  slug_taken: 'This slug is already in use',
  slug_in_trash: 'This slug belongs to an artifact in the trash: restore it or delete it for good',
  no_thumbnail: 'No thumbnail',
  file_missing: 'Missing file',
  invalid_boolean: '{field} must be a boolean',
  code_needs_code_visibility: 'A code only makes sense with “code” visibility',
  code_required: 'A code is required',
  link_not_found: 'Link not found or already revoked',
  no_content: 'No published content',
  version_not_found: 'Version not found',
  already_current: 'Already the current version',
  folder_not_found: 'Folder not found',
  invalid_folder_name: 'Invalid name: letters, digits and hyphens, 32 characters max',
  folder_exists: 'A folder already has this name',
  project_exists: 'A project already has this name',
  invalid_ids: 'ids: a list of identifiers is expected',
  invalid_bulk_ids: 'ids: 1 to {max} distinct identifiers are expected',
  invalid_bulk_op: 'Unknown bulk operation',
  bulk_no_code: 'The “code” visibility is set one artifact at a time',
  too_many_tags: '“{title}” would carry more than {max} tags',
  folder_changed: 'The folder contents changed: reload and try again',
  invalid_parent: 'Invalid folder parent',
  parent_missing: 'Unknown parent folder',
  parent_self: 'A folder cannot contain itself',
  parent_cycle: 'A folder cannot move into one of its sub-folders',
  parent_depth: 'Folders are limited to 4 levels',
  invalid_names: 'Invalid folder list',
  thumb_unsupported: 'Thumbnail: WebP, PNG or JPEG image expected (declared type and content must match)',
  thumb_too_large: 'Thumbnail too large (2 MiB max)',
  upload_interrupted: 'Upload interrupted',
  multipart_expected: 'Multipart request expected',
  multipart_invalid: 'Invalid multipart request',
  file_too_large: 'File too large ({max} MB max)',
  unsupported_format: 'Unsupported format (HTML, Markdown, PDF, JSON or ZIP)',
  invalid_pdf: 'This file is not a valid PDF',
  text_too_large: 'Text file too large (5 MB max for Markdown and JSON)',
  invalid_json: 'Invalid JSON: {detail}',
  zip_unreadable: 'Unreadable archive: {detail}',
  zip_invalid: 'Invalid archive: {detail}',
  zip_nul_byte: 'Invalid file name (null byte)',
  zip_absolute_path: 'Absolute path refused: {name}',
  zip_traversal: 'Path traversal refused: {name}',
  zip_empty_name: 'Empty file name',
  zip_too_many_files: 'Too many files (max {max})',
  zip_symlink: 'Symbolic link refused: {name}',
  zip_ratio: 'Suspicious compression ratio: {name}',
  zip_reserved_name: 'Reserved name: {name}',
  zip_no_index: 'index.html not found at the root of the archive',
  zip_outside: 'Path outside the destination: {name}',
  zip_too_large: 'Archive too large once extracted (max {max} bytes)',
} as const;

export type ErrorCode = keyof typeof ERRORS;
export type ErrorParams = Record<string, string | number>;

export function errorMessage(code: ErrorCode, params?: ErrorParams): string {
  return ERRORS[code].replace(/\{(\w+)\}/g, (m, k: string) => (params && k in params ? String(params[k]) : m));
}

/** An error that carries a stable code (ingest, ZIP extraction), converted to an HTTP error by the API. */
export class CodedError extends Error {
  code: ErrorCode;
  params?: ErrorParams;
  constructor(code: ErrorCode, params?: ErrorParams) {
    super(errorMessage(code, params));
    this.code = code;
    this.params = params;
  }
}
