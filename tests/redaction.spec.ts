// Secret redaction unit tests: stable kind detection, fixed-marker masking,
// negative cases that must NOT fire (normal prose, short values, names).

import { describe, expect, it } from 'vitest'

import { REDACTED, detectSecrets, maskSecrets } from '../src/redaction.ts'

const GH = `ghp_${'a'.repeat(36)}`
const FINE = `github_pat_${'b'.repeat(40)}`
const NPM = `npm_${'c'.repeat(36)}`
const SK = `sk-${'d'.repeat(24)}`
const AKIA = `AKIA${'E'.repeat(16)}`
const AIZA = `AIza${'f'.repeat(35)}`
const BEARER = `Bearer ${'g'.repeat(20)}`
const PRIV = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAabcdefghijklmnopqrstuvwxyz\n-----END RSA PRIVATE KEY-----'
const ASSIGN = `token: ${'h'.repeat(16)}`

describe('secret redaction', () => {
  it('detects every known secret shape with its stable kind', () => {
    expect(detectSecrets(GH)).toEqual(['github-pat'])
    expect(detectSecrets(FINE)).toEqual(['github-fine-grained'])
    expect(detectSecrets(NPM)).toEqual(['npm-token'])
    expect(detectSecrets(SK)).toEqual(['openai-key'])
    expect(detectSecrets(AKIA)).toEqual(['aws-access-key'])
    expect(detectSecrets(AIZA)).toEqual(['google-api-key'])
    expect(detectSecrets(BEARER)).toEqual(['bearer-token'])
    expect(detectSecrets(PRIV)).toEqual(['private-key'])
    expect(detectSecrets(`sk-proj-${'k'.repeat(40)}`)).toEqual(['openai-key'])
    expect(detectSecrets(`sk-svcacct-${'k'.repeat(40)}`)).toEqual(['openai-key'])
    expect(detectSecrets(ASSIGN)).toEqual(['credential-assignment'])
    expect(detectSecrets(`a note mentioning ${GH} and ${SK}`)).toEqual(['github-pat', 'openai-key'])
  })

  it('reports kinds only — never the secret itself', () => {
    const kinds = detectSecrets(`store ${NPM} for publish`)
    expect(kinds).toEqual(['npm-token'])
    expect(kinds.join(' ')).not.toContain('npm_')
  })

  it('does not fire on normal prose or short values', () => {
    expect(detectSecrets('use tabs for indentation')).toEqual([])
    expect(detectSecrets('token: short')).toEqual([])
    expect(detectSecrets('api key is in the vault')).toEqual([])
    expect(detectSecrets('the pnpm store dir is local')).toEqual([])
    expect(detectSecrets('password manager recommended')).toEqual([])
    expect(detectSecrets('ghp_short')).toEqual([])
    expect(detectSecrets('')).toEqual([])
  })

  it('masks every detected span with the fixed marker', () => {
    expect(maskSecrets(ASSIGN + ' ok')).toBe(`${REDACTED} ok`)
    expect(maskSecrets(`${GH} and ${SK}`)).toBe(`${REDACTED} and ${REDACTED}`)
    expect(maskSecrets('clean text')).toBe('clean text')
  })

  it('masks the full PEM block, key material included', () => {
    const masked = maskSecrets(`key material follows:\n${PRIV}\nend`)
    expect(masked).not.toContain('MIIEowIBAAKCAQEA')
    expect(masked).not.toContain('PRIVATE KEY')
    expect(masked).toContain(REDACTED)
  })
})
