# obsidian-mcp-on-claude

use 
https://modelcontextprotocol.io/quickstart/server#test-with-commands


## SETUP

First of all, this code works on Claude Desctop.

if you have not already done, please do so here
https://claude.ai/download

Second, the app is created assuming a specific valut of obsidian. In other words, it basically performs searches, etc. on md files. If you change the file path appropriately, you may be able to use it for other file operations, but in that case, please rewrite the code.

Also, in addition to this code, there are two other things needed to prepare this MCP server mechanism on Claude.

One is `claude_desctop_config.json`, the other is the node execution environment.
You can use node by yourself. At least a 16 series or higher spec is required.

claude_desctop_config.json is described in the “quick start guide” shown at the beginning of this document, so please refer to it for usage.

sample:

```json
{
  "mcpServers": {
    "obsidian": {
      "command": "/your/node/path/to/node",
      "args": [
        "/your/path/to/this/repository/obsidian-mcp/build/index.js"
      ],
      "env": {
    "OBSIDIAN_VAULT_PATH": "/your/path/to/Obsidian/vault/path/dir"
  }
    }
  },
  "globalShortcut": ""
}

```

The dotenv is required when inspector is run, but in actual operation it could not work without the environment variable in this json file, so please set it.

Basically, run npm run build, which is the command found in package.json, and then run npm run start to start the script

After activation, Claude must be restarted.
If the tool obsidian-xxxx is available as shown in the image, you are ready to go.

![SCR-20250314-jehw](https://github.com/user-attachments/assets/802fc02b-e68f-4cc3-8f55-a018d49ba843)


