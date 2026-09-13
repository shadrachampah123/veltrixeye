import { z } from 'zod';

/**
 * User & account model (foundation).
 *
 * SaaS readiness: `plan` exists now (default 'free') so subscription tiers
 * can be introduced later without a migration. Limits (strategies/alerts/
 * markets per tier) are enforced centrally later via a plan-limits config;
 * see docs/architecture.md "SaaS readiness".
 */
export const USER_PLANS = ['free', 'pro', 'premium'] as const;
export type UserPlan = (typeof USER_PLANS)[number];

export const userPlanSchema = z.enum(USER_PLANS);

export interface UserDto {
  id: string;
  email: string;
  name: string;
  plan: UserPlan;
  createdAt: string;
  updatedAt: string;
}

export interface SessionDto {
  id: string;
  userAgent: string | null;
  ip: string | null;
  createdAt: string;
  expiresAt: string;
  lastSeenAt: string | null;
  current: boolean;
}
