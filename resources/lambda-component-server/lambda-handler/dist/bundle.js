"use strict";let e;Object.defineProperty(exports,"__esModule",{value:!0}),e=require("./component-server"),e.default&&(e=e.default),exports.handler=async function handler(r,t){t.callbackWaitsForEmptyEventLoop=!1;const{query:n,version:o}=r;return await e.receiveQuery(n,{version:o})};
