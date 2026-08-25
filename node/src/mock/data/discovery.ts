import {
  SCHEMA_ENTERPRISE_USER,
  SCHEMA_ENTRA_GROUP,
  SCHEMA_ENTRA_USER,
  SCHEMA_GROUP_CORE,
  SCHEMA_LIST_RESPONSE,
  SCHEMA_USER_CORE,
  type ResourceType,
  type ServiceProviderConfig,
} from "../../scim/types.js";

/**
 * Shape mirrors the documented response at
 * https://learn.microsoft.com/entra/identity/app-provisioning/entra-id-scim-api-reference
 * — strict mode advertises cursor-only pagination like the real API;
 * validator-compat additionally advertises index pagination.
 */
export function serviceProviderConfig(validatorCompat: boolean): ServiceProviderConfig {
  return {
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"],
    documentationUri: "/graph/overview",
    pagination: {
      cursor: true,
      index: validatorCompat,
      defaultPaginationMethod: "cursor",
      defaultPageSize: 100,
      maxPageSize: 1000,
    },
    patch: { supported: true },
    bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
    filter: { supported: true, maxResults: 200 },
    authenticationSchemes: [
      {
        type: "oauthbearertoken",
        name: "OAuth Bearer Token",
        description:
          "Authentication via OAuth 2.0 bearer token (mock accepts its configured static token).",
      },
    ],
  };
}

const USER_RESOURCE_TYPE: ResourceType = {
  schemas: ["urn:ietf:params:scim:schemas:core:2.0:ResourceType"],
  id: "User",
  name: "User",
  endpoint: "/Users",
  description: "User Account",
  schema: SCHEMA_USER_CORE,
  schemaExtensions: [
    { schema: SCHEMA_ENTERPRISE_USER, required: true },
    { schema: SCHEMA_ENTRA_USER, required: true },
  ],
  meta: { location: "/resourcetypes/user", resourceType: "resourceType" },
};

const GROUP_RESOURCE_TYPE: ResourceType = {
  schemas: ["urn:ietf:params:scim:schemas:core:2.0:ResourceType"],
  id: "Group",
  name: "Group",
  endpoint: "/Groups",
  description: "Group",
  schema: SCHEMA_GROUP_CORE,
  schemaExtensions: [{ schema: SCHEMA_ENTRA_GROUP, required: true }],
  meta: { location: "/resourcetypes/group", resourceType: "resourceType" },
};

export function resourceTypesList(): Record<string, unknown> {
  return {
    schemas: [SCHEMA_LIST_RESPONSE],
    totalResults: 2,
    Resources: [USER_RESOURCE_TYPE, GROUP_RESOURCE_TYPE],
  };
}

export function resourceTypeById(id: string): ResourceType | undefined {
  const lower = id.toLowerCase();
  if (lower === "user") return USER_RESOURCE_TYPE;
  if (lower === "group") return GROUP_RESOURCE_TYPE;
  return undefined;
}
