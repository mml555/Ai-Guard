import { writeFileSync } from "node:fs";
import { buildOpenApiDocument } from "./plugins/openApi";

writeFileSync("openapi.json", `${JSON.stringify(buildOpenApiDocument(), null, 2)}\n`);
