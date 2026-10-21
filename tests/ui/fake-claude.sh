#!/bin/sh
sleep 1
echo '{"type":"system","subtype":"init","session_id":"fake-sess","model":"claude-opus-5-5"}'
echo '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"node ~/apps/wizard-troubleshooter/bin/status.mjs"}}]}}'
sleep 2
echo '{"type":"assistant","message":{"content":[{"type":"text","text":"The **Agent Service** had stopped. I restarted it and checked `/wizard/health`: it answers again. Try sending a message now."}]}}'
echo '{"type":"result","session_id":"fake-sess","is_error":false}'
