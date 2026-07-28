/**
 * OAuth Discovery Utilities for MCP Servers
 *
 * Implements RFC 9728 OAuth Protected Resource Discovery and related
 * authentication probing mechanisms to detect OAuth requirements before
 * attempting the full OAuth flow.
 */

import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js'
import { logMCPDebug } from '../../utils/log.js'

/**
 * Result of probing an MCP server for authentication requirements.
 */
export interface AuthProbeResult {
  /** Whether the server requires OAuth authentication */
  requiresAuth: boolean
  /** The WWW-Authenticate header value if auth is required */
  wwwAuthenticate?: string
  /** The resource_metadata URL extracted from WWW-Authenticate header */
  resourceMetadataUrl?: URL
  /** The authorization server URL discovered from resource metadata */
  authorizationServerUrl?: string
}

/**
 * OAuth Protected Resource Metadata (RFC 9728 §2)
 */
interface OAuthProtectedResourceMetadata {
  resource: string
  authorization_servers?: string[]
  bearer_methods_supported?: string[]
  resource_documentation?: string
  resource_signing_alg_values_supported?: string[]
  resource_encryption_alg_values_supported?: string[]
  resource_encryption_enc_values_supported?: string[]
}

/**
 * OAuth Authorization Server Metadata (RFC 8414)
 */
interface OAuthAuthorizationServerMetadata {
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  token_endpoint_auth_methods_supported?: string[]
  revocation_endpoint?: string
  revocation_endpoint_auth_methods_supported?: string[]
  registration_endpoint?: string
  response_types_supported?: string[]
  grant_types_supported?: string[]
  code_challenge_methods_supported?: string[]
  scopes_supported?: string[]
}

/**
 * Well-known URLs for RFC 9728 discovery
 */
interface WellKnownUrls {
  protectedResource: string
  authorizationServer: string
}

/**
 * Discovered OAuth configuration for an MCP server
 */
export interface DiscoveredOAuthConfig {
  authorizationUrl: string
  tokenUrl: string
  issuer: string
  scopes?: string[]
  registrationUrl?: string
}

const SERVER_NAME = 'oauthDiscovery'

/**
 * Parse WWW-Authenticate header for resource_metadata URL (RFC 9728 §3.2)
 *
 * Parses headers like:
 *   Bearer realm="api", resource_metadata="https://auth.example.com/.well-known/oauth-protected-resource"
 */
export function parseWWWAuthenticateHeader(header: string): URL | null {
  // RFC 9728 §3.2: The resource_metadata is included in the WWW-Authenticate header
  // Format: Bearer realm="...", resource_metadata="<url>", ...
  const match = header.match(/resource_metadata="([^"]+)"/)
  if (match) {
    try {
      return new URL(match[1])
    } catch {
      logMCPDebug(SERVER_NAME, `Invalid resource_metadata URL in WWW-Authenticate: ${match[1]}`)
      return null
    }
  }

  // Also check for unquoted value (RFC 6750 §3 allows either)
  const unquotedMatch = header.match(/resource_metadata=([^\s,]+)/)
  if (unquotedMatch) {
    try {
      return new URL(unquotedMatch[1])
    } catch {
      return null
    }
  }

  return null
}

/**
 * Build well-known URLs per RFC 9728 §3.1
 *
 * Constructs URLs by inserting /.well-known/oauth-protected-resource
 * between the host and path.
 */
export function buildWellKnownUrls(baseUrl: string): WellKnownUrls {
  const serverUrl = new URL(baseUrl)
  const base = `${serverUrl.protocol}//${serverUrl.host}`
  const pathSuffix = serverUrl.pathname.replace(/\/$/, '') // Remove trailing slash

  return {
    protectedResource: new URL(
      `/.well-known/oauth-protected-resource${pathSuffix}`,
      base,
    ).toString(),
    authorizationServer: new URL(
      `/.well-known/oauth-authorization-server${pathSuffix}`,
      base,
    ).toString(),
  }
}

/**
 * Fetch protected resource metadata per RFC 9728 §2
 */
async function fetchProtectedResourceMetadata(
  resourceMetadataUrl: URL,
  fetchFn: FetchLike,
): Promise<OAuthProtectedResourceMetadata | null> {
  try {
    const response = await fetchFn(resourceMetadataUrl.toString(), {
      method: 'GET',
      headers: {
        Accept: 'application/json',
      },
    })

    if (!response.ok) {
      logMCPDebug(
        SERVER_NAME,
        `Protected resource metadata request failed: ${response.status}`,
      )
      return null
    }

    return (await response.json()) as OAuthProtectedResourceMetadata
  } catch (error) {
    logMCPDebug(
      SERVER_NAME,
      `Failed to fetch protected resource metadata: ${error}`,
    )
    return null
  }
}

/**
 * Fetch authorization server metadata (RFC 8414)
 */
async function fetchAuthorizationServerMetadata(
  metadataUrl: URL,
  fetchFn: FetchLike,
): Promise<OAuthAuthorizationServerMetadata | null> {
  try {
    const response = await fetchFn(metadataUrl.toString(), {
      method: 'GET',
      headers: {
        Accept: 'application/json',
      },
    })

    if (!response.ok) {
      return null
    }

    return (await response.json()) as OAuthAuthorizationServerMetadata
  } catch {
    return null
  }
}

/**
 * Discover authorization server metadata, trying multiple endpoints (RFC 8414)
 */
async function discoverAuthorizationServerMetadata(
  authServerUrl: string,
  fetchFn: FetchLike,
): Promise<OAuthAuthorizationServerMetadata | null> {
  const authUrl = new URL(authServerUrl)
  const base = `${authUrl.protocol}//${authUrl.host}`

  const endpointsToTry: string[] = []

  // With pathname: try path-inserted and path-appended variants
  if (authUrl.pathname !== '/') {
    // OAuth 2.0 Authorization Server Metadata (path inserted)
    endpointsToTry.push(
      new URL(
        `/.well-known/oauth-authorization-server${authUrl.pathname}`,
        base,
      ).toString(),
    )

    // OpenID Connect Discovery 1.0 (path inserted)
    endpointsToTry.push(
      new URL(
        `/.well-known/openid-configuration${authUrl.pathname}`,
        base,
      ).toString(),
    )

    // OpenID Connect Discovery 1.0 (path appended)
    endpointsToTry.push(
      new URL(
        `${authUrl.pathname}/.well-known/openid-configuration`,
        base,
      ).toString(),
    )
  }

  // Root-level endpoints
  endpointsToTry.push(
    new URL('/.well-known/oauth-authorization-server', base).toString(),
  )
  endpointsToTry.push(
    new URL('/.well-known/openid-configuration', base).toString(),
  )

  for (const endpoint of endpointsToTry) {
    const metadata = await fetchAuthorizationServerMetadata(
      new URL(endpoint),
      fetchFn,
    )
    if (metadata) {
      logMCPDebug(SERVER_NAME, `Discovered auth server metadata at ${endpoint}`)
      return metadata
    }
  }

  return null
}

/**
 * Build the resource parameter for OAuth requests (RFC 9728 §3.1)
 */
export function buildResourceParameter(endpointUrl: string): string {
  const url = new URL(endpointUrl)
  return `${url.protocol}//${url.host}${url.pathname}`
}

/**
 * Check if an endpoint is an SSE endpoint (needs text/event-stream Accept header)
 */
function isSSEEndpoint(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.pathname.endsWith('/sse') || parsed.searchParams.has('sse')
  } catch {
    return false
  }
}

/**
 * Probe an MCP server to detect if it requires OAuth authentication.
 *
 * Sends a HEAD request to the server and checks for:
 * - 401/307 status with WWW-Authenticate header indicating auth is required
 * - 403 status with non-JSON body (potential auth requirement with poor error handling)
 *
 * @param serverUrl - The URL of the MCP server to probe
 * @param fetchFn - Optional fetch function to use
 * @returns AuthProbeResult indicating whether auth is required and discovered configuration
 */
export async function probeServerForAuth(
  serverUrl: string,
  fetchFn?: FetchLike,
): Promise<AuthProbeResult> {
  const fetch = fetchFn ?? globalThis.fetch

  logMCPDebug(SERVER_NAME, `Probing server for auth requirements: ${serverUrl}`)

  try {
    const headers: HeadersInit = isSSEEndpoint(serverUrl)
      ? { Accept: 'text/event-stream' }
      : { Accept: 'application/json' }

    const response = await fetch(serverUrl, {
      method: 'HEAD',
      headers,
    })

    // 401 or 307 with WWW-Authenticate indicates auth is required
    if (response.status === 401 || response.status === 307) {
      const wwwAuth = response.headers.get('www-authenticate')

      if (wwwAuth) {
        logMCPDebug(
          SERVER_NAME,
          `Server responded with ${response.status}, WWW-Authenticate header present`,
        )

        const resourceMetadataUrl = parseWWWAuthenticateHeader(wwwAuth)

        return {
          requiresAuth: true,
          wwwAuthenticate: wwwAuth,
          resourceMetadataUrl: resourceMetadataUrl ?? undefined,
        }
      }

      // 401/307 without WWW-Authenticate might still need auth
      return {
        requiresAuth: true,
        wwwAuthenticate: undefined,
      }
    }

    // Check for 403 with non-JSON body (Figma pattern)
    if (response.status === 403) {
      const contentType = response.headers.get('content-type')

      if (contentType && !contentType.includes('application/json')) {
        logMCPDebug(
          SERVER_NAME,
          `Server returned non-JSON 403, may require OAuth (content-type: ${contentType})`,
        )

        // Still return requiresAuth: false here because we need more info
        // The OAuth discovery flow will handle this case
      }
    }

    logMCPDebug(
      SERVER_NAME,
      `Server does not require auth (status: ${response.status})`,
    )
    return { requiresAuth: false }
  } catch (error) {
    logMCPDebug(SERVER_NAME, `Auth probe failed: ${error}`)
    return { requiresAuth: false }
  }
}

/**
 * Discover OAuth configuration from an MCP server using RFC 9728 discovery.
 *
 * @param serverUrl - The URL of the MCP server
 * @param fetchFn - Optional fetch function to use
 * @returns DiscoveredOAuthConfig or null if discovery fails
 */
export async function discoverOAuthConfigFromServer(
  serverUrl: string,
  fetchFn?: FetchLike,
): Promise<DiscoveredOAuthConfig | null> {
  const fetch = fetchFn ?? globalThis.fetch

  logMCPDebug(
    SERVER_NAME,
    `Starting OAuth discovery for ${serverUrl}`,
  )

  try {
    // RFC 9728 §3.1: Build well-known URLs
    const wellKnownUrls = buildWellKnownUrls(serverUrl)
    let resourceMetadata = await fetchProtectedResourceMetadata(
      new URL(wellKnownUrls.protectedResource),
      fetch,
    )

    // Fallback: If path-based discovery fails, try root-based discovery
    if (!resourceMetadata) {
      const url = new URL(serverUrl)
      if (url.pathname && url.pathname !== '/') {
        const rootBasedUrls = buildWellKnownUrls(
          `${url.protocol}//${url.host}`,
        )
        resourceMetadata = await fetchProtectedResourceMetadata(
          new URL(rootBasedUrls.protectedResource),
          fetch,
        )
      }
    }

    // If we have resource metadata, get authorization server info
    if (resourceMetadata?.authorization_servers?.length) {
      const authServerUrl = resourceMetadata.authorization_servers[0]
      const authServerMetadata = await discoverAuthorizationServerMetadata(
        authServerUrl,
        fetch,
      )

      if (authServerMetadata) {
        logMCPDebug(
          SERVER_NAME,
          `Discovered OAuth config: issuer=${authServerMetadata.issuer}`,
        )

        return {
          issuer: authServerMetadata.issuer,
          authorizationUrl: authServerMetadata.authorization_endpoint,
          tokenUrl: authServerMetadata.token_endpoint,
          scopes: authServerMetadata.scopes_supported,
          registrationUrl: authServerMetadata.registration_endpoint,
        }
      }
    }

    // Fallback: Try well-known endpoint directly at the server URL
    const authServerMetadata = await discoverAuthorizationServerMetadata(
      serverUrl,
      fetch,
    )

    if (authServerMetadata) {
      return {
        issuer: authServerMetadata.issuer,
        authorizationUrl: authServerMetadata.authorization_endpoint,
        tokenUrl: authServerMetadata.token_endpoint,
        scopes: authServerMetadata.scopes_supported,
        registrationUrl: authServerMetadata.registration_endpoint,
      }
    }

    logMCPDebug(
      SERVER_NAME,
      `OAuth discovery failed for ${serverUrl}`,
    )
    return null
  } catch (error) {
    logMCPDebug(
      SERVER_NAME,
      `OAuth discovery error: ${error}`,
    )
    return null
  }
}

/**
 * Discover OAuth configuration from WWW-Authenticate header.
 *
 * @param wwwAuthenticate - The WWW-Authenticate header value
 * @param mcpServerUrl - Optional MCP server URL for resource validation
 * @param fetchFn - Optional fetch function to use
 * @returns DiscoveredOAuthConfig or null if discovery fails
 */
export async function discoverOAuthFromWWWAuthenticate(
  wwwAuthenticate: string,
  mcpServerUrl?: string,
  fetchFn?: FetchLike,
): Promise<DiscoveredOAuthConfig | null> {
  const fetch = fetchFn ?? globalThis.fetch

  logMCPDebug(
    SERVER_NAME,
    `Discovering OAuth from WWW-Authenticate header`,
  )

  const resourceMetadataUri = parseWWWAuthenticateHeader(wwwAuthenticate)
  if (!resourceMetadataUri) {
    logMCPDebug(
      SERVER_NAME,
      `No resource_metadata found in WWW-Authenticate header`,
    )
    return null
  }

  const resourceMetadata = await fetchProtectedResourceMetadata(
    resourceMetadataUri,
    fetch,
  )

  if (!resourceMetadata) {
    return null
  }

  // Validate resource parameter if MCP server URL is provided (RFC 9728 §7.3)
  if (mcpServerUrl) {
    const expectedResource = buildResourceParameter(mcpServerUrl)
    const discoveredResource = buildResourceParameter(resourceMetadata.resource)

    if (discoveredResource !== expectedResource) {
      logMCPDebug(
        SERVER_NAME,
        `Resource mismatch: expected ${expectedResource}, got ${discoveredResource}`,
      )
      // Don't fail here, continue with discovered resource
    }
  }

  if (!resourceMetadata.authorization_servers?.length) {
    return null
  }

  const authServerUrl = resourceMetadata.authorization_servers[0]
  const authServerMetadata = await discoverAuthorizationServerMetadata(
    authServerUrl,
    fetch,
  )

  if (authServerMetadata) {
    return {
      issuer: authServerMetadata.issuer,
      authorizationUrl: authServerMetadata.authorization_endpoint,
      tokenUrl: authServerMetadata.token_endpoint,
      scopes: authServerMetadata.scopes_supported,
      registrationUrl: authServerMetadata.registration_endpoint,
    }
  }

  return null
}
