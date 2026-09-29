import type { Tool } from "../tool-types";
import type { FacadeLookup } from "./shared";
import { buildProductivityFacades } from "./productivity";
import { buildFilesFacade } from "./files";
import { buildContentFacades } from "./content";
import { buildCodeFacade } from "./code";

export const DOMAIN_FACADE_NAMES = [
  "calendar", "todo", "contacts", "files", "documents", "spreadsheet", "presentation", "code",
] as const;

export function buildDomainFacadeTools(lookup: FacadeLookup): Tool[] {
  return [
    ...buildProductivityFacades(lookup),
    buildFilesFacade(lookup),
    ...buildContentFacades(lookup),
    buildCodeFacade(lookup),
  ];
}
