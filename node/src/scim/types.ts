export const SCIM_BASE_URL = "https://graph.microsoft.com/rp/scim";

export const SCHEMA_USER_CORE = "urn:ietf:params:scim:schemas:core:2.0:User";
export const SCHEMA_GROUP_CORE = "urn:ietf:params:scim:schemas:core:2.0:Group";
export const SCHEMA_ENTERPRISE_USER =
  "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User";
export const SCHEMA_ENTRA_USER =
  "urn:ietf:params:scim:schemas:extension:Microsoft:Entra:2.0:User";
export const SCHEMA_ENTRA_GROUP =
  "urn:ietf:params:scim:schemas:extension:Microsoft:Entra:2.0:Group";
export const SCHEMA_ENTRA_CSA =
  "urn:ietf:params:scim:schemas:extension:Microsoft:Entra:2.0:CustomSecurityAttributes";
export const SCHEMA_PATCH_OP = "urn:ietf:params:scim:api:messages:2.0:PatchOp";
export const SCHEMA_LIST_RESPONSE =
  "urn:ietf:params:scim:api:messages:2.0:ListResponse";

export interface ScimMeta {
  resourceType?: string;
  created?: string;
  lastModified?: string;
  location?: string;
  version?: string;
}

/**
 * Both casings of the resources array are declared on purpose, and neither is
 * dead: the Entra SCIM API answers with canonical `Resources` on some
 * endpoints and lowercase `resources` on others. Do not read either key
 * directly — put the payload through normalizeListResponse in ./pagination.js,
 * which collapses the two.
 */
export interface ScimListResponse<T> {
  schemas: string[];
  totalResults?: number;
  itemsPerPage?: number;
  startIndex?: number;
  nextCursor?: string;
  Resources?: T[];
  resources?: T[];
}

export interface ScimName {
  formatted?: string;
  familyName?: string;
  givenName?: string;
  middleName?: string;
  honorificPrefix?: string;
  honorificSuffix?: string;
}

export interface ScimEmail {
  value: string;
  type?: string;
  primary?: boolean;
}

export interface ScimPhoneNumber {
  value: string;
  type?: string;
  primary?: boolean;
}

export interface ScimAddress {
  type?: string;
  streetAddress?: string;
  locality?: string;
  region?: string;
  postalCode?: string;
  country?: string;
  formatted?: string;
  primary?: boolean;
}

export interface ScimGroupRef {
  value: string;
  display?: string;
  type?: string;
  $ref?: string;
}

export interface EnterpriseUserExtension {
  employeeNumber?: string;
  costCenter?: string;
  organization?: string;
  division?: string;
  department?: string;
  manager?: { value: string; displayName?: string; $ref?: string };
}

export interface EntraUserExtension {
  mailNickname?: string;
  userType?: string;
  employeeLeaveDateTime?: string;
  onPremisesImmutableId?: string;
  preferredLanguage?: string;
}

export interface EntraGroupExtension {
  description?: string;
  mailEnabled?: boolean;
  mailNickname?: string;
  securityEnabled?: boolean;
  groupTypes?: string[];
  securityIdentifier?: string;
}

/**
 * A user as the API *returns* it.
 *
 * `password` is deliberately absent. The API never echoes one, and leaving it
 * off the read type means no code path hands a caller a resource whose type
 * advertises a secret. Writes use ScimUserCreatePayload.
 *
 * The index signature below means this is a convention the compiler can help
 * with, not a wall it enforces — `password` is still reachable as `unknown`,
 * as any URN-qualified key must be. The guarantee is the runtime one:
 * stripSecrets in ../tools/util.js, on the way out to the model.
 */
export interface ScimUser {
  schemas: string[];
  id?: string;
  externalId?: string;
  userName?: string;
  active?: boolean;
  displayName?: string;
  name?: ScimName;
  emails?: ScimEmail[];
  phoneNumbers?: ScimPhoneNumber[];
  addresses?: ScimAddress[];
  groups?: ScimGroupRef[];
  meta?: ScimMeta;
  [SCHEMA_ENTERPRISE_USER]?: EnterpriseUserExtension;
  [SCHEMA_ENTRA_USER]?: EntraUserExtension;
  [SCHEMA_ENTRA_CSA]?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * A user as the API *accepts* it on POST /users. `password` is declared only
 * here, so a value typed for writing cannot be returned without saying so.
 */
export interface ScimUserCreatePayload extends ScimUser {
  password?: string;
}

export interface ScimGroupMember {
  value: string;
  display?: string;
  type?: string;
  $ref?: string;
}

export interface ScimGroup {
  schemas: string[];
  id?: string;
  externalId?: string;
  displayName: string;
  members?: ScimGroupMember[];
  meta?: ScimMeta;
  [SCHEMA_ENTRA_GROUP]?: EntraGroupExtension;
  [key: string]: unknown;
}

export type ScimPatchOpName = "add" | "remove" | "replace";

export interface ScimPatchOperation {
  op: ScimPatchOpName;
  path?: string;
  value?: unknown;
}

export interface ScimPatchBody {
  schemas: [typeof SCHEMA_PATCH_OP];
  Operations: ScimPatchOperation[];
}

export interface ServiceProviderConfig {
  schemas: string[];
  documentationUri?: string;
  pagination?: {
    cursor?: boolean;
    index?: boolean;
    defaultPaginationMethod?: "cursor" | "index";
    defaultPageSize?: number;
    maxPageSize?: number;
  };
  patch?: { supported: boolean };
  bulk?: { supported: boolean; maxOperations: number; maxPayloadSize: number };
  filter?: { supported: boolean; maxResults: number };
  [key: string]: unknown;
}

export interface ResourceType {
  schemas: string[];
  id: string;
  name: string;
  endpoint: string;
  description?: string;
  schema: string;
  schemaExtensions?: { schema: string; required: boolean }[];
  meta?: ScimMeta;
}

export interface ScimSchema {
  id: string;
  name: string;
  description?: string;
  attributes: unknown[];
  meta?: ScimMeta;
}
