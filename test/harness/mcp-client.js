/**
 * Lightweight MCP client that spawns the unbounce-mcp server as a subprocess
 * and speaks JSON-RPC over stdio.
 *
 * - Streams stderr to the current process's stderr in real time, prefixed [mcp].
 * - Optionally tees stderr to a file (for the interactive runner's .test-runs/).
 * - Parses stdout as newline-delimited JSON-RPC frames.
 * - Handles the initialize / notifications/initialized handshake automatically.
 */

import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SERVER_PATH = path.resolve(__dirname, '../../index.js')

const DEFAULT_REQUEST_TIMEOUT_MS = 5 * 60 * 1000

export class McpClient {
  constructor({ env = {}, stderrFile = null, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS } = {}) {
    this.env = env
    this.stderrFile = stderrFile
    this.timeoutMs = timeoutMs
    this.proc = null
    this.pending = new Map()
    this.nextId = 1
    this.stdoutBuf = ''
    this.exited = false
  }

  async start() {
    this.proc = spawn('node', [SERVER_PATH], {
      env: { ...process.env, ...this.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    this.proc.stdout.setEncoding('utf8')
    this.proc.stdout.on('data', chunk => this._onStdout(chunk))

    this.proc.stderr.setEncoding('utf8')
    this.proc.stderr.on('data', chunk => this._onStderr(chunk))

    this.proc.on('exit', code => this._onExit(code))

    await this._request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'unbounce-mcp-harness', version: '0.0.0' },
    })

    this._notify('notifications/initialized')
  }

  _onStdout(chunk) {
    this.stdoutBuf += chunk
    let nl
    while ((nl = this.stdoutBuf.indexOf('\n')) !== -1) {
      const line = this.stdoutBuf.slice(0, nl)
      this.stdoutBuf = this.stdoutBuf.slice(nl + 1)
      if (!line.trim()) continue
      let msg
      try { msg = JSON.parse(line) } catch { continue }
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve, reject, timer } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        clearTimeout(timer)
        if (msg.error) reject(new Error(`MCP error: ${msg.error.message}`))
        else resolve(msg.result)
      }
    }
  }

  _onStderr(chunk) {
    const prefixed = chunk
      .split('\n')
      .map((l, i, arr) => (i === arr.length - 1 && !l ? l : `[mcp] ${l}`))
      .join('\n')
    process.stderr.write(prefixed)
    if (this.stderrFile) {
      fs.appendFileSync(this.stderrFile, chunk)
    }
  }

  _onExit(code) {
    this.exited = true
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer)
      reject(new Error(`MCP server exited (code ${code}) before responding`))
    }
    this.pending.clear()
  }

  _request(method, params) {
    if (this.exited) return Promise.reject(new Error('MCP server has exited'))
    const id = this.nextId++
    const frame = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`MCP request timed out: ${method}`))
      }, this.timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.proc.stdin.write(frame)
    })
  }

  _notify(method, params) {
    const frame = JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n'
    this.proc.stdin.write(frame)
  }

  async listTools() {
    return this._request('tools/list', {})
  }

  async call(name, args) {
    return this._request('tools/call', { name, arguments: args })
  }

  async close() {
    if (!this.proc || this.exited) return
    this.proc.kill('SIGTERM')
    await new Promise(resolve => {
      if (this.exited) resolve()
      else this.proc.once('exit', resolve)
    })
  }
}
