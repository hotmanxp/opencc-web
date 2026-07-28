/**
 * OAuth types for OpenCC.ai authentication
 */

// Subscription types for OpenCC.ai plans
// Using string type to match mockRateLimits.ts which uses type SubscriptionType = string
export type SubscriptionType = string

// Rate limit tier
export type RateLimitTier = string | null

// Billing types
export type BillingType =
  | 'stripe_subscription'
  | 'stripe_subscription_contracted'
  | 'apple_subscription'
  | 'google_play_subscription'
  | null

// OAuth token exchange response from the API
export interface OAuthTokenExchangeResponse {
  access_token: string
  refresh_token?: string
  expires_in: number
  scope?: string
  account?: {
    uuid: string
    email_address: string
  }
  organization?: {
    uuid: string
  }
}

// OAuth tokens stored after successful authentication
export interface OAuthTokens {
  accessToken: string
  refreshToken: string | null
  expiresAt: number | null
  scopes: string[]
  subscriptionType: SubscriptionType | null
  rateLimitTier: RateLimitTier
  profile?: OAuthProfileResponse
  tokenAccount?: {
    uuid: string
    emailAddress: string
    organizationUuid: string
  }
}

// OAuth profile response from /api/oauth/profile
export interface OAuthProfileResponse {
  id: string
  email: string
  name: string
  account?: {
    uuid: string
    email: string
    display_name?: string
    created_at?: string
  }
  organization?: {
    uuid: string
    name: string
    organization_type?: 'claude_max' | 'claude_pro' | 'claude_enterprise' | 'claude_team'
    rate_limit_tier?: string
    billing_type?: BillingType
    has_extra_usage_enabled?: boolean
    subscription_created_at?: string
  }
}

// User roles response
export interface UserRolesResponse {
  organization_role: string
  workspace_role: string
}

// Referral types
export type ReferralCampaign = string

export interface ReferralEligibilityResponse {
  eligible: boolean
  remaining_passes?: number
  max_passes?: number
  campaign?: string
  reason?: string
}

export interface ReferralRedemptionsResponse {
  redemptions: ReferralRedemption[]
}

export interface ReferralRedemption {
  id: string
  created_at: string
  referrer_user_id: string
  reward_type: string
}

export interface ReferrerRewardInfo {
  total_rewards: number
  available_rewards: number
}
