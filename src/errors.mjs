export class RunnerValidationError extends Error {
  constructor(code, message) { super(message); this.name = 'RunnerValidationError'; this.code = code; }
}
