export const BACKEND_URL =
  process.env.NEXT_PUBLIC_BACKEND_URL === "http://localhost:3001"
    ? "http://localhost:3001/api"
    : `${process.env.NEXT_PUBLIC_BACKEND_URL}/api`;
export const STRIPE_PUBLISHABLE_KEY = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY ?? "";


export const IS_CLOUD = process.env.NEXT_PUBLIC_CLOUD === "true";
// rybbit-unlocked: separates "cloud features" from "cloud billing". IS_CLOUD still means billing/quotas/
// commercial flows; CLOUD_FEATURES gates features that only need their own runtime dependencies. See UNLOCK.md.
export const UNLOCK_CLOUD_FEATURES = process.env.NEXT_PUBLIC_UNLOCK_CLOUD_FEATURES !== "false";
export const CLOUD_FEATURES = IS_CLOUD || UNLOCK_CLOUD_FEATURES;
export const DEPLOYMENT = process.env.NEXT_PUBLIC_DEPLOYMENT;
export const LITE_DASHBOARD = process.env.NEXT_PUBLIC_LITE_DASHBOARD === "true";

// Time constants
export const MINUTES_IN_24_HOURS = 24 * 60; // 1440 minutes

export const DEMO_HOSTNAME = "demo.rybbit.com";

export const FREE_SITE_LIMIT = 1;
export const STANDARD_SITE_LIMIT = 5;
export const STANDARD_TEAM_LIMIT = 3;
export const BASIC_SITE_LIMIT = 1;
export const BASIC_TEAM_LIMIT = 1;