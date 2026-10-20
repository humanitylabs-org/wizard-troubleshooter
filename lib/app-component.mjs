// A normal app is not a host administrator. Report the missing trust boundary,
// without invoking probes or exposing the host-only guardian/chat/actions.
export const containerReadiness = () => ({
  ready: false,
  mode: 'isolated-app',
  reason: 'host-component-not-provisioned',
  message: 'The app is installed, but host recovery is not connected. Use the independent SSH/console repair kit. Do not add host mounts or bypass authentication.',
  runbook: 'https://github.com/humanitylabs-org/wizard-os/blob/main/docs/REPAIR.md',
});

export function appRpc(msg) {
  const id = msg?.id ?? null;
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return { jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid request' } };
  if (msg.id === undefined) return null;
  let result;
  switch (msg.method) {
    case 'initialize':
      result = { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'wizard-troubleshooter', version: '0.1.0' } }; break;
    case 'ping': result = {}; break;
    case 'tools/list':
      result = { tools: [{ name: 'recovery_readiness', description: 'Read-only: reports whether this isolated app has an independent host repair component. No secrets, host probes, restarts or repair chat.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }] }; break;
    case 'tools/call':
      if (msg.params?.name !== 'recovery_readiness') return { jsonrpc: '2.0', id, error: { code: -32602, message: 'Unknown tool' } };
      result = { content: [{ type: 'text', text: JSON.stringify(containerReadiness()) }] }; break;
    default: return { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } };
  }
  return { jsonrpc: '2.0', id, result };
}
