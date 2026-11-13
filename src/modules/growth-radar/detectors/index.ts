import type { DetectorId } from "../types.js";
import type { DetectorSpec } from "./spec.js";
import { trafficWithoutLeads } from "./traffic-without-leads.js";
import { pageConversionGap } from "./page-conversion-gap.js";
import { formRateDecline } from "./form-rate-decline.js";
import { searchCtrGap } from "./search-ctr-gap.js";
import { bookingDecline } from "./booking-decline.js";

export const DETECTORS: Record<DetectorId, DetectorSpec> = {
  trafficWithoutLeads,
  pageConversionGap,
  formRateDecline,
  searchCtrGap,
  bookingDecline,
};

export type { DetectorSpec };
