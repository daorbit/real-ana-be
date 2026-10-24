import { alertServerResponse } from "../../infra/monitoring/ops-alert.js";
import { runAfterResponse } from "../../shared/utils/after-response.js";
import { createServerErrorReporter } from "./server-error-reporter.js";

export { markServerErrorReported } from "./server-error-reporter.js";

export const reportServerErrors = createServerErrorReporter((status, report) => {
  runAfterResponse("server error alert", () => alertServerResponse(status, report));
});
