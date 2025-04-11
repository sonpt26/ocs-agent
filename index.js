// Import function schemas
import functionSchemas from './function_schemas.json' assert { type: 'json' };
import promptMd from './prompt.txt' assert { type: 'text' };

// Convert function schemas to tools format
const TOOLS = functionSchemas.map(schema => ({
  type: "function",
  function: schema,
}));

// In-memory stores
const conversations = new Map();
const processing = new Map();

// Configuration
const DEEPSEEK_API_URL = "https://api.deepseek.com/v1/chat/completions";

// Function to call SQL API
async function callSqlApi(query, sqlApiBaseUrl) {
  const upperQuery = query.toUpperCase();
  let url = "";
  if (upperQuery.includes("SELECT")) {
    url = `${sqlApiBaseUrl}api/sql/query`;
  } else if (
    upperQuery.includes("INSERT") ||
    upperQuery.includes("UPDATE") ||
    upperQuery.includes("DELETE")
  ) {
    url = `${sqlApiBaseUrl}api/sql/mutate`;
  } else {
    return { error: "Invalid query type" };
  }
  console.log("callSqlApi ", url)

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query }),
    });
    if (!response.ok) {
      throw new Error(`HTTP error ${response.status}`);
    }
    const data = await response.json();
    console.log("Response from backend:", data);
    return data;
  } catch (error) {
    return { error: `API call error: ${error.message}` };
  }
}

// Generate a UUID
function generateUuid() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// WebSocket handler
export default {
  async fetch(request, env, ctx) {
    console.log("Environment keys:", Object.keys(env));

    const SYSTEM_PROMPT = promptMd;
    if (!SYSTEM_PROMPT) {
      console.error("PROMPT_MD not set in environment");
      return new Response("Error: PROMPT_MD environment variable not set", { status: 500 });
    }

    const DEEPSEEK_API_KEY = env.DEEPSEEK_API_KEY;
    if (!DEEPSEEK_API_KEY) {
      console.error("DEEPSEEK_API_KEY not set in environment");
      return new Response("Error: DEEPSEEK_API_KEY environment variable not set", { status: 500 });
    }

    const SQL_API_BASE_URL = env.SQL_API_BASE_URL;
    if (!SQL_API_BASE_URL) {
      console.error("SQL_API_BASE_URL not set in environment");
      return new Response("Error: SQL_API_BASE_URL environment variable not set", { status: 500 });
    }

    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }

    const { 0: clientWebSocket, 1: serverWebSocket } = new WebSocketPair();
    serverWebSocket.accept();

    const conversationId = generateUuid();
    conversations.set(conversationId, [
      {
        role: "system",
        content: SYSTEM_PROMPT,
      },
    ]);
    processing.set(conversationId, false);
    serverWebSocket.send(JSON.stringify({ error: "Xin chào. Tôi là trợ lý nghiệp vụ khai báo gói cước. Tôi có thể giúp gì bạn?" }));
    serverWebSocket.addEventListener("message", async (event) => {
      try {
        const data = JSON.parse(event.data);
        const message = data.message;

        if (!message) {
          serverWebSocket.send(
            JSON.stringify({ error: "No message content provided." })
          );
          return;
        }

        if (processing.get(conversationId)) {
          serverWebSocket.send(
            JSON.stringify({
              error: "Processing previous message, please wait.",
            })
          );
          return;
        }

        processing.set(conversationId, true);
        const messages = conversations.get(conversationId);
        messages.push({ role: "user", content: message });
        // serverWebSocket.send(JSON.stringify({ progress: `You: ${message}` }));

        const maxIterations = 10;
        let iteration = 0;

        while (iteration < maxIterations) {
          try {
            console.log("Calling DeepSeek API with payload:", {
              model: "deepseek-chat",
              messages,
              tools: TOOLS,
            });
            const response = await fetch(DEEPSEEK_API_URL, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${DEEPSEEK_API_KEY}`,
              },
              body: JSON.stringify({
                model: "deepseek-chat",
                messages,
                tools: TOOLS,
              }),
            });

            console.log("DeepSeek API response status:", response.status);
            if (!response.ok) {
              const errorBody = await response.text();
              console.error("DeepSeek API error body:", errorBody);
              throw new Error(`DeepSeek API error ${response.status}: ${errorBody}`);
            }

            const data = await response.json();
            console.log("DeepSeek API response:", data);

            const { choices } = data;
            const messageResponse = choices[0].message;
            messages.push(messageResponse);

            if (!messageResponse.tool_calls || messageResponse.tool_calls.length === 0) {
              serverWebSocket.send(
                JSON.stringify({ response: messageResponse.content })
              );
              break;
            }

            for (const toolCall of messageResponse.tool_calls) {
              const functionName = toolCall.function.name;
              let agrs;
              try {
                agrs = JSON.parse(toolCall.function.arguments);
              } catch {
                serverWebSocket.send(
                  JSON.stringify({ error: "Invalid tool call arguments." })
                );
                break;
              }

              const query = agrs.query;
              if (!query) {
                serverWebSocket.send(
                  JSON.stringify({ error: "Missing query parameter." })
                );
                break;
              }

              const description =
                messageResponse.content ||
                (functionName === "run_sql_query"
                  ? "Querying data...[" + query + "]"
                  : "Updating data...[" + query + "]");
              serverWebSocket.send(JSON.stringify({ progress: description }));

              if (functionName === "run_sql_query") {
                if (!query.toUpperCase().includes("SELECT")) {
                  serverWebSocket.send(
                    JSON.stringify({
                      error: "run_sql_query is only for SELECT queries.",
                    })
                  );
                  break;
                }

                const result = await callSqlApi(query, SQL_API_BASE_URL);
                const resultStr = JSON.stringify(result);
                messages.push({
                  role: "tool",
                  tool_call_id: toolCall.id,
                  content: resultStr,
                });

              } else if (functionName === "run_sql_mutation") {
                if (
                  !["INSERT", "UPDATE", "DELETE"].some((op) =>
                    query.toUpperCase().includes(op)
                  )
                ) {
                  serverWebSocket.send(
                    JSON.stringify({
                      error:
                        "run_sql_mutation is only for INSERT, UPDATE, DELETE queries.",
                    })
                  );
                  break;
                }

                const result = await callSqlApi(query, SQL_API_BASE_URL);
                const resultStr = JSON.stringify(result);
                messages.push({
                  role: "tool",
                  tool_call_id: toolCall.id,
                  content: resultStr,
                });

              } else {
                serverWebSocket.send(
                  JSON.stringify({ error: `Unknown function: ${functionName}` })
                );
                break;
              }
            }

            iteration++;
          } catch (error) {
            console.error("Error in DeepSeek API call:", error);
            serverWebSocket.send(
              JSON.stringify({ error: `DeepSeek API error: ${error.message}` })
            );
            break;
          }
        }

        if (iteration >= maxIterations) {
          serverWebSocket.send(
            JSON.stringify({ error: "Reached maximum function call limit." })
          );
        }

        processing.set(conversationId, false);
      } catch (error) {
        console.error("WebSocket message error:", error);
        serverWebSocket.send(
          JSON.stringify({ error: `Error: ${error.message}` })
        );
        processing.set(conversationId, false);
      }
    });

    serverWebSocket.addEventListener("close", () => {
      conversations.delete(conversationId);
      processing.delete(conversationId);
      console.log("WebSocket closed for conversation:", conversationId);
    });

    serverWebSocket.addEventListener("error", (error) => {
      console.error("WebSocket error:", error);
      conversations.delete(conversationId);
      processing.delete(conversationId);
    });

    return new Response(null, {
      status: 101,
      webSocket: clientWebSocket,
    });
  },
};