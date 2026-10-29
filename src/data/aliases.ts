/**
 * Repos whose main package cannot be guessed from the repo name: monorepos
 * with a scoped flagship package, or projects named differently on the registry.
 * Keyed by lowercase "owner/repo". Keep it short; the verified guess covers the rest.
 */
import { type Ecosystem } from '../ecosystems.js';

export const ALIASES: Record<string, { ecosystem: Ecosystem; name: string }> = {
  'vuejs/core': { ecosystem: 'npm', name: 'vue' },
  'angular/angular': { ecosystem: 'npm', name: '@angular/core' },
  'modelcontextprotocol/typescript-sdk': { ecosystem: 'npm', name: '@modelcontextprotocol/sdk' },
  'modelcontextprotocol/python-sdk': { ecosystem: 'pypi', name: 'mcp' },
  'pytorch/pytorch': { ecosystem: 'pypi', name: 'torch' },
  'tensorflow/tensorflow': { ecosystem: 'pypi', name: 'tensorflow' },
  'aws/aws-sdk-js-v3': { ecosystem: 'npm', name: '@aws-sdk/client-s3' },
  'aws/aws-sdk-js': { ecosystem: 'npm', name: 'aws-sdk' },
  'googleapis/google-api-nodejs-client': { ecosystem: 'npm', name: 'googleapis' },
  'googleapis/google-cloud-python': { ecosystem: 'pypi', name: 'google-cloud-storage' },
  'microsoft/typescript': { ecosystem: 'npm', name: 'typescript' },
  'babel/babel': { ecosystem: 'npm', name: '@babel/core' },
  'nestjs/nest': { ecosystem: 'npm', name: '@nestjs/core' },
  'tanstack/query': { ecosystem: 'npm', name: '@tanstack/react-query' },
  'reduxjs/redux-toolkit': { ecosystem: 'npm', name: '@reduxjs/toolkit' },
  'emotion-js/emotion': { ecosystem: 'npm', name: '@emotion/react' },
  'apollographql/apollo-client': { ecosystem: 'npm', name: '@apollo/client' },
  'prisma/prisma': { ecosystem: 'npm', name: 'prisma' },
  'supabase/supabase-js': { ecosystem: 'npm', name: '@supabase/supabase-js' },
  'firebase/firebase-js-sdk': { ecosystem: 'npm', name: 'firebase' },
  'huggingface/transformers': { ecosystem: 'pypi', name: 'transformers' },
  'rust-lang/rust': { ecosystem: 'cargo', name: 'std' },
  'rails/rails': { ecosystem: 'rubygems', name: 'rails' },
  'anthropics/anthropic-sdk-typescript': { ecosystem: 'npm', name: '@anthropic-ai/sdk' },
  'anthropics/anthropic-sdk-python': { ecosystem: 'pypi', name: 'anthropic' },
  'openai/openai-node': { ecosystem: 'npm', name: 'openai' },
  'openai/openai-python': { ecosystem: 'pypi', name: 'openai' },
};
