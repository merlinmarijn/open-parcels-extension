import { renderOrigins } from "./origin-list.js";

const list = document.getElementById("origins");
if (list !== null) void renderOrigins(list, true);
