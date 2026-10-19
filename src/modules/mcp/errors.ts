export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolError";
  }
}

export class ToolTimeoutError extends Error {
  constructor() {
    super("tool timed out");
    this.name = "ToolTimeoutError";
  }
}
