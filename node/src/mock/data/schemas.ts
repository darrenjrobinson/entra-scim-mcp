import {
  SCHEMA_ENTERPRISE_USER,
  SCHEMA_ENTRA_CSA,
  SCHEMA_ENTRA_GROUP,
  SCHEMA_ENTRA_USER,
  SCHEMA_GROUP_CORE,
  SCHEMA_LIST_RESPONSE,
  SCHEMA_USER_CORE,
  type ScimSchema,
} from "../../scim/types.js";

interface AttrOptions {
  multiValued?: boolean;
  required?: boolean;
  mutability?: "readOnly" | "readWrite" | "immutable" | "writeOnly";
  returned?: "always" | "never" | "default" | "request";
  uniqueness?: "none" | "server" | "global";
  subAttributes?: unknown[];
}

function attr(
  name: string,
  type: string,
  opts: AttrOptions = {},
): Record<string, unknown> {
  return {
    name,
    type,
    multiValued: opts.multiValued ?? false,
    required: opts.required ?? false,
    caseExact: false,
    mutability: opts.mutability ?? "readWrite",
    returned: opts.returned ?? "default",
    uniqueness: opts.uniqueness ?? "none",
    ...(opts.subAttributes ? { subAttributes: opts.subAttributes } : {}),
  };
}

const multiValuedSub = [
  attr("value", "string"),
  attr("type", "string"),
  attr("primary", "boolean"),
];

const USER_SCHEMA: ScimSchema = {
  id: SCHEMA_USER_CORE,
  name: "User",
  description: "User Account",
  attributes: [
    attr("userName", "string", { required: true, uniqueness: "server" }),
    attr("password", "string", { mutability: "writeOnly", returned: "never" }),
    attr("displayName", "string", { required: true }),
    attr("active", "boolean", { required: true }),
    attr("externalId", "string"),
    attr("preferredLanguage", "string"),
    attr("name", "complex", {
      required: true,
      subAttributes: [
        attr("formatted", "string"),
        attr("familyName", "string", { required: true }),
        attr("givenName", "string", { required: true }),
        attr("middleName", "string"),
        attr("honorificPrefix", "string"),
        attr("honorificSuffix", "string"),
      ],
    }),
    attr("emails", "complex", { multiValued: true, subAttributes: multiValuedSub }),
    attr("phoneNumbers", "complex", { multiValued: true, subAttributes: multiValuedSub }),
    attr("addresses", "complex", {
      multiValued: true,
      subAttributes: [
        attr("type", "string"),
        attr("streetAddress", "string"),
        attr("locality", "string"),
        attr("region", "string"),
        attr("postalCode", "string"),
        attr("country", "string"),
        attr("formatted", "string"),
        attr("primary", "boolean"),
      ],
    }),
    attr("groups", "complex", {
      multiValued: true,
      mutability: "readOnly",
      subAttributes: [attr("value", "string", { mutability: "readOnly" })],
    }),
  ],
  meta: { resourceType: "Schema", location: `/schemas/${SCHEMA_USER_CORE}` },
};

const GROUP_SCHEMA: ScimSchema = {
  id: SCHEMA_GROUP_CORE,
  name: "Group",
  description: "Group",
  attributes: [
    attr("displayName", "string", { required: true }),
    attr("externalId", "string"),
    attr("members", "complex", {
      multiValued: true,
      subAttributes: [
        attr("value", "string"),
        attr("display", "string"),
        attr("type", "string"),
      ],
    }),
  ],
  meta: { resourceType: "Schema", location: `/schemas/${SCHEMA_GROUP_CORE}` },
};

const ENTERPRISE_USER_SCHEMA: ScimSchema = {
  id: SCHEMA_ENTERPRISE_USER,
  name: "EnterpriseUser",
  description: "Enterprise User",
  attributes: [
    attr("employeeNumber", "string"),
    attr("costCenter", "string"),
    attr("organization", "string"),
    attr("division", "string"),
    attr("department", "string"),
    attr("manager", "complex", {
      subAttributes: [
        attr("value", "string"),
        attr("displayName", "string", { mutability: "readOnly" }),
      ],
    }),
  ],
  meta: { resourceType: "Schema", location: `/schemas/${SCHEMA_ENTERPRISE_USER}` },
};

const ENTRA_USER_SCHEMA: ScimSchema = {
  id: SCHEMA_ENTRA_USER,
  name: "MicrosoftEntraUser",
  description: "Microsoft Entra User Extension",
  attributes: [
    attr("mailNickname", "string", { required: true }),
    attr("userType", "string"),
    attr("employeeLeaveDateTime", "dateTime"),
    attr("onPremisesImmutableId", "string"),
    attr("preferredLanguage", "string"),
  ],
  meta: { resourceType: "Schema", location: `/schemas/${SCHEMA_ENTRA_USER}` },
};

const ENTRA_GROUP_SCHEMA: ScimSchema = {
  id: SCHEMA_ENTRA_GROUP,
  name: "MicrosoftEntraGroup",
  description: "Microsoft Entra Group Extension",
  attributes: [
    attr("description", "string"),
    attr("mailEnabled", "boolean"),
    attr("mailNickname", "string"),
    attr("securityEnabled", "boolean"),
    attr("groupTypes", "string", { multiValued: true }),
    attr("securityIdentifier", "string", { mutability: "readOnly" }),
  ],
  meta: { resourceType: "Schema", location: `/schemas/${SCHEMA_ENTRA_GROUP}` },
};

/**
 * CSA definitions are tenant-specific in the real API; the mock ships a small
 * demo attribute set ("Project") matching the documented example.
 */
const CSA_SCHEMA: ScimSchema = {
  id: SCHEMA_ENTRA_CSA,
  name: "MicrosoftEntraCustomSecurityAttributes",
  description: "Microsoft Entra Custom Security Attributes",
  attributes: [
    attr("Project", "complex", {
      returned: "request",
      subAttributes: [attr("ProjectName", "String", { returned: "default" })],
    }),
  ],
  meta: { resourceType: "Schema", location: `/schemas/${SCHEMA_ENTRA_CSA}` },
};

const ALL_SCHEMAS: ScimSchema[] = [
  USER_SCHEMA,
  GROUP_SCHEMA,
  ENTERPRISE_USER_SCHEMA,
  ENTRA_USER_SCHEMA,
  ENTRA_GROUP_SCHEMA,
  CSA_SCHEMA,
];

/**
 * The Microsoft SCIM Validator refuses to run at all against a User schema
 * that advertises `password` — it fails test-data generation with "The
 * attribute password for User is not supported by the SCIM protocol", even
 * though RFC 7643 §4.1.1 defines it (writeOnly, returned: never). The real
 * Entra inbound API both advertises and *requires* password on create, so
 * strict mode keeps advertising it and only validator-compat hides it.
 */
function schemasFor(validatorCompat: boolean): ScimSchema[] {
  if (!validatorCompat) return ALL_SCHEMAS;
  return ALL_SCHEMAS.map((schema) =>
    schema.id === SCHEMA_USER_CORE
      ? {
          ...schema,
          attributes: schema.attributes.filter(
            (a) => (a as { name?: string }).name !== "password",
          ),
        }
      : schema,
  );
}

export function schemasList(validatorCompat = false): Record<string, unknown> {
  const schemas = schemasFor(validatorCompat);
  return {
    schemas: [SCHEMA_LIST_RESPONSE],
    totalResults: schemas.length,
    Resources: schemas,
  };
}

export function schemaById(id: string, validatorCompat = false): ScimSchema | undefined {
  const lower = id.toLowerCase();
  return schemasFor(validatorCompat).find((schema) => schema.id.toLowerCase() === lower);
}
