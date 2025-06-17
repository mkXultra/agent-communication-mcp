#!/usr/bin/env node

// Simple test to verify MCP server starts up
import { spawn } from 'child_process';
import { join } from 'path';

async function testServer() {
  console.log('Testing MCP Server startup...');
  
  const serverPath = join(__dirname, 'dist', 'index.js');
  
  const server = spawn('node', [serverPath], {
    stdio: 'pipe',
    env: { ...process.env, AGENT_COMM_DATA_DIR: './test-data' }
  });
  
  let output = '';
  let errorOutput = '';
  
  server.stdout.on('data', (data) => {
    output += data.toString();
  });
  
  server.stderr.on('data', (data) => {
    errorOutput += data.toString();
    console.error('Server stderr:', data.toString());
  });
  
  // Give server time to start
  await new Promise(resolve => setTimeout(resolve, 2000));
  
  // Send test request
  const testRequest = {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/list',
    params: {}
  };
  
  server.stdin.write(JSON.stringify(testRequest) + '\n');
  
  // Wait for response
  await new Promise(resolve => setTimeout(resolve, 1000));
  
  // Kill server
  server.kill();
  
  console.log('Server output:', output);
  console.log('Server started successfully:', errorOutput.includes('Agent Communication MCP Server started'));
}

testServer().catch(console.error);