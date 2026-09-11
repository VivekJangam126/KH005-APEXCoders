/**
 * LLM Adapter - Supports multiple LLM providers
 * Gemini, Ollama, Together AI, OpenRouter, etc.
 */

import { config } from './config.ts';

export interface LLMResponse {
  text: string;
  model: string;
}

export interface LLMConfig {
  provider: 'gemini' | 'ollama' | 'together' | 'openrouter' | 'huggingface';
  model: string;
  apiKey?: string;
  baseUrl?: string;
  temperature?: number;
}

class OllamaLLM {
  private baseUrl: string;
  private model: string;

  constructor(model: string = 'mistral', baseUrl: string = 'http://localhost:11434') {
    this.baseUrl = baseUrl;
    this.model = model;
  }

  async generate(prompt: string, temperature: number = 0.1): Promise<LLMResponse> {
    try {
      const response = await fetch(`${this.baseUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          prompt,
          stream: false,
          temperature,
          top_p: 0.95,
          top_k: 40,
        }),
      });

      if (!response.ok) {
        throw new Error(`Ollama error: ${response.statusText}`);
      }

      const data = await response.json();
      return {
        text: data.response,
        model: this.model,
      };
    } catch (error: any) {
      console.error('[Ollama] Error:', error.message);
      throw error;
    }
  }

  async isAvailable(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`, { timeout: 5000 });
      return response.ok;
    } catch {
      return false;
    }
  }
}

class TogetherAILLM {
  private apiKey: string;
  private model: string;

  constructor(apiKey: string, model: string = 'mistralai/Mistral-7B-Instruct-v0.1') {
    this.apiKey = apiKey;
    this.model = model;
  }

  async generate(prompt: string, temperature: number = 0.1): Promise<LLMResponse> {
    try {
      const response = await fetch('https://api.together.xyz/inference', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          prompt,
          max_tokens: 2048,
          temperature,
          top_p: 0.95,
          top_k: 40,
        }),
      });

      if (!response.ok) {
        throw new Error(`Together AI error: ${response.statusText}`);
      }

      const data = await response.json();
      return {
        text: data.output?.choices[0]?.text || '',
        model: this.model,
      };
    } catch (error: any) {
      console.error('[Together AI] Error:', error.message);
      throw error;
    }
  }
}

class OpenRouterLLM {
  private apiKey: string;
  private model: string;

  constructor(apiKey: string, model: string = 'mistralai/mistral-7b-instruct') {
    this.apiKey = apiKey;
    this.model = model;
  }

  async generate(prompt: string, temperature: number = 0.1): Promise<LLMResponse> {
    try {
      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          messages: [{ role: 'user', content: prompt }],
          temperature,
          top_p: 0.95,
        }),
      });

      if (!response.ok) {
        throw new Error(`OpenRouter error: ${response.statusText}`);
      }

      const data = await response.json();
      return {
        text: data.choices[0]?.message?.content || '',
        model: this.model,
      };
    } catch (error: any) {
      console.error('[OpenRouter] Error:', error.message);
      throw error;
    }
  }
}

class HuggingFaceLLM {
  private apiKey: string;
  private model: string;

  constructor(apiKey: string, model: string = 'mistralai/Mistral-7B-Instruct-v0.1') {
    this.apiKey = apiKey;
    this.model = model;
  }

  async generate(prompt: string, temperature: number = 0.1): Promise<LLMResponse> {
    try {
      const response = await fetch(
        `https://api-inference.huggingface.co/models/${this.model}`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            inputs: prompt,
            parameters: {
              max_length: 2048,
              temperature,
              top_p: 0.95,
            },
          }),
        }
      );

      if (!response.ok) {
        throw new Error(`Hugging Face error: ${response.statusText}`);
      }

      const data = await response.json();
      const text = Array.isArray(data) ? data[0]?.generated_text : data?.generated_text;
      return {
        text: text || '',
        model: this.model,
      };
    } catch (error: any) {
      console.error('[Hugging Face] Error:', error.message);
      throw error;
    }
  }
}

let llmInstance: OllamaLLM | TogetherAILLM | OpenRouterLLM | HuggingFaceLLM | null = null;
let currentProvider: string | null = null;

/**
 * Initialize LLM provider based on environment variables
 * Priority:
 * 1. OLLAMA_MODEL (if Ollama is running locally)
 * 2. TOGETHER_API_KEY + TOGETHER_MODEL
 * 3. OPENROUTER_API_KEY + OPENROUTER_MODEL
 * 4. HUGGINGFACE_API_KEY + HUGGINGFACE_MODEL
 */
export async function initializeLLM(): Promise<void> {
  console.log('[LLM] Initializing LLM provider...');

  // Try Ollama first (local, free)
  const ollamaModel = process.env.OLLAMA_MODEL || 'mistral';
  const ollamaUrl = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
  const ollama = new OllamaLLM(ollamaModel, ollamaUrl);
  
  try {
    const available = await ollama.isAvailable();
    if (available) {
      llmInstance = ollama;
      currentProvider = 'ollama';
      console.log(`[LLM] ✓ Using Ollama (${ollamaModel})`);
      return;
    }
  } catch (err) {
    console.log('[LLM] Ollama not available, trying other providers...');
  }

  // Try Together AI
  if (process.env.TOGETHER_API_KEY) {
    const model = process.env.TOGETHER_MODEL || 'mistralai/Mistral-7B-Instruct-v0.1';
    llmInstance = new TogetherAILLM(process.env.TOGETHER_API_KEY, model);
    currentProvider = 'together';
    console.log(`[LLM] ✓ Using Together AI (${model})`);
    return;
  }

  // Try OpenRouter
  if (process.env.OPENROUTER_API_KEY) {
    const model = process.env.OPENROUTER_MODEL || 'mistralai/mistral-7b-instruct';
    llmInstance = new OpenRouterLLM(process.env.OPENROUTER_API_KEY, model);
    currentProvider = 'openrouter';
    console.log(`[LLM] ✓ Using OpenRouter (${model})`);
    return;
  }

  // Try Hugging Face
  if (process.env.HUGGINGFACE_API_KEY) {
    const model = process.env.HUGGINGFACE_MODEL || 'mistralai/Mistral-7B-Instruct-v0.1';
    llmInstance = new HuggingFaceLLM(process.env.HUGGINGFACE_API_KEY, model);
    currentProvider = 'huggingface';
    console.log(`[LLM] ✓ Using Hugging Face (${model})`);
    return;
  }

  console.log('[LLM] ⚠ No LLM provider configured. Falling back to deterministic SQL generation.');
  console.log('[LLM] Set one of these environment variables:');
  console.log('  - OLLAMA_MODEL=mistral (requires Ollama running on localhost:11434)');
  console.log('  - TOGETHER_API_KEY + TOGETHER_MODEL');
  console.log('  - OPENROUTER_API_KEY + OPENROUTER_MODEL');
  console.log('  - HUGGINGFACE_API_KEY + HUGGINGFACE_MODEL');
}

export async function generateWithLLM(
  prompt: string,
  temperature: number = 0.1
): Promise<LLMResponse | null> {
  if (!llmInstance) {
    return null;
  }

  try {
    return await llmInstance.generate(prompt, temperature);
  } catch (error) {
    console.error('[LLM] Generation failed:', error);
    return null;
  }
}

export function getCurrentProvider(): string | null {
  return currentProvider;
}
