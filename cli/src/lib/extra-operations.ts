/**
 * Search endpoints that exist on the API but are absent from its OpenAPI document.
 *
 * `zcli` uses these internally; they are the platform's Elasticsearch-backed query surface.
 * They are hand-declared here rather than generated, and flagged `undocumented`, because
 * nothing upstream promises they are stable.
 *
 * Two things they do that the documented GET list endpoints cannot:
 *
 *   1. `POST /project/search` enforces per-project ACLs, while `GET /client/{id}/project`
 *      demands organization-level read. A project-scoped token — the shape most CI and agent
 *      setups use — gets 403 from the latter and a correct answer from the former.
 *   2. Date-range filtering and multi-field sorting, which the list endpoints do not expose.
 *
 * Verified live against api.app-prg1.zerops.io with a project-scoped token.
 */
import type { OperationDef } from "../generated/operations.ts";

/** Comparison operators the API accepts, by field type. Anything else is rejected outright. */
export const SEARCH_OPERATORS = {
  string: ["eq", "ne"],
  date: ["gt", "gte", "lt", "lte"],
} as const;

const FILTER_DOC = `Body is an EsFilter:

  {
    "search": [ { "name": "<field>", "operator": "<op>", "value": "<value>" } ],
    "sort":   [ { "name": "<field>", "ascending": true|false } ],
    "limit":  <int>,
    "offset": <int>
  }

"search" and "sort" are both required, even when empty. Operators are type-dependent: string
fields accept eq and ne; date fields accept gt, gte, lt and lte. Nested fields use dotted paths
("build.serviceStackId"). Most resources require a clientId term. The response carries
totalHits alongside items, so offset/limit paginate properly.

Note: the top-level "text" field in the DTO is accepted but does not filter.`;

function searchOp(
  resource: string,
  path: string,
  summary: string,
  requires: string[],
): OperationDef {
  return {
    id: `Search${resource}`,
    method: "POST",
    path: `/api/rest/public/${path}/search`,
    tag: "Search",
    summary: `${summary} (undocumented endpoint)`,
    description: `${summary}

NOT in the published OpenAPI document — declared from the zerops-go SDK and verified by hand.
May change without notice.${requires.length ? `\n\nRequires a search term for: ${requires.join(", ")}.` : ""}

${FILTER_DOC}`,
    roles: [],
    params: [],
    body: "EsFilter",
    response: null,
    deprecated: false,
    auth: true,
  };
}

export const EXTRA_OPERATIONS: readonly OperationDef[] = [
  searchOp("Project", "project", "Query projects, honouring per-project access", ["clientId"]),
  searchOp("ServiceStack", "service-stack", "Query services", ["clientId"]),
  searchOp("AppVersion", "app-version", "Query app versions across services", ["clientId"]),
  searchOp("Process", "process", "Query processes, with date-range filtering", ["clientId"]),
  searchOp("Container", "container", "Query containers", ["clientId"]),
  searchOp("UserData", "user-data", "Query environment variables across services", ["clientId"]),
  searchOp("PublicHttpRouting", "public-http-routing", "Query HTTP routes", ["clientId"]),
  searchOp("PublicPortRouting", "public-port-routing", "Query port routes", ["clientId"]),
  searchOp("ServiceStackType", "service-stack-type", "Query the service catalog", []),
  searchOp("Service", "service", "Query service processes", ["clientId"]),
  searchOp("ClientUser", "client-user", "Query organization members", ["clientId"]),
  searchOp("UserNotification", "user-notification", "Query notifications", ["clientId"]),
  searchOp("CardPayment", "card-payment", "Query card payments", ["clientId"]),
  searchOp("Client", "client", "Query organizations", ["id"]),
  searchOp("Country", "country", "Query the country list", []),
  searchOp("Currency", "currency", "Query the currency list", []),
  searchOp("Language", "language", "Query the language list", []),
];

export interface SearchTerm {
  name: string;
  operator: string;
  value: string;
}

export interface SearchFilter {
  search: SearchTerm[];
  sort: { name: string; ascending: boolean }[];
  limit?: number;
  offset?: number;
}

/** Both `search` and `sort` are mandatory upstream, so build filters through this. */
export function esFilter(
  search: SearchTerm[],
  options: { sort?: { name: string; ascending: boolean }[]; limit?: number; offset?: number } = {},
): SearchFilter {
  return {
    search,
    sort: options.sort ?? [],
    ...(options.limit !== undefined ? { limit: options.limit } : {}),
    ...(options.offset !== undefined ? { offset: options.offset } : {}),
  };
}
