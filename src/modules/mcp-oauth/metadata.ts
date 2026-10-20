import { endpointPath, endpointResourceUrl, issuerUrl, type McpEndpoint } from "./config.js";
import { ALL_SCOPES } from "./scopes.js";

export function authorizationServerMetadata() {
  const issuer = issuerUrl();
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    revocation_endpoint: `${issuer}/oauth/revoke`,
    scopes_supported: ALL_SCOPES,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    revocation_endpoint_auth_methods_supported: ["none"],
    authorization_response_iss_parameter_supported: true,
  };
}

export function protectedResourceMetadata(endpoint: McpEndpoint = {}) {
  return {
    resource: endpointResourceUrl(endpoint),
    authorization_servers: [issuerUrl()],
    scopes_supported: ALL_SCOPES,
    bearer_methods_supported: ["header"],
    resource_name: "Quantalog",
  };
}

export function protectedResourceMetadataUrl(endpoint: McpEndpoint = {}): string {
  return `${issuerUrl()}/.well-known/oauth-protected-resource${endpointPath(endpoint)}`;
}
