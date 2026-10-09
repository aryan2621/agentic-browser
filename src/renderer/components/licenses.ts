import type { LicenseId } from '@shared/types'

export const LICENSES: Record<
  LicenseId,
  { name: string; url: string; aup?: string; summary: string }
> = {
  'llama3.2': {
    name: 'Llama 3.2 Community License',
    url: 'https://github.com/meta-llama/llama-models/blob/main/models/llama3_2/LICENSE',
    aup: 'https://github.com/meta-llama/llama-models/blob/main/models/llama3_2/USE_POLICY.md',
    summary:
      'Free to use, reproduce and modify, including commercially, subject to the Acceptable Use Policy. Redistribution must include the license and display “Built with Llama”. Products with more than 700M monthly active users need a separate license from Meta.'
  },
  'llama3.1': {
    name: 'Llama 3.1 Community License',
    url: 'https://github.com/meta-llama/llama-models/blob/main/models/llama3_1/LICENSE',
    aup: 'https://github.com/meta-llama/llama-models/blob/main/models/llama3_1/USE_POLICY.md',
    summary:
      'Free to use, reproduce and modify, including commercially, subject to the Acceptable Use Policy. Redistribution must include the license and display “Built with Llama”. Products with more than 700M monthly active users need a separate license from Meta.'
  },
  mit: {
    name: 'MIT License',
    url: 'https://github.com/openai/whisper/blob/main/LICENSE',
    summary: 'Permissive open-source license (OpenAI Whisper, converted by whisper.cpp).'
  },
  'apache-2.0': {
    name: 'Apache License 2.0',
    url: 'https://www.apache.org/licenses/LICENSE-2.0',
    summary: 'Permissive open-source license (nomic-embed-text).'
  }
}
