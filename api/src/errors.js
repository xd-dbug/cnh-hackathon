export class HttpError extends Error {
  /**
   * @param {number} status HTTP status code
   * @param {string} message goes out as {"error": message}
   */
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
