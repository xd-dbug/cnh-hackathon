/** An error whose message is safe and useful to show to a user in `conferences.error`. */
export class UserError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UserError';
  }
}

// Exactly the text in contract/examples/conference-failed.json.
export const UNSUPPORTED_SITE_MESSAGE =
  'Unsupported site: no schedule found. Supported: Sessionize, Pretalx, frab/Pentabarf XML, Sched, iCal (.ics), schema.org JSON-LD events.';

export class UnsupportedSiteError extends UserError {
  constructor() {
    super(UNSUPPORTED_SITE_MESSAGE);
    this.name = 'UnsupportedSiteError';
  }
}
