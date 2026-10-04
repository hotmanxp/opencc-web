// @ts-nocheck
import { c as _c } from "react-compiler-runtime";
import React from 'react';
import { BLACK_CIRCLE } from '../../constants/figures.js';
import {  } from '../../constants/product.js'
import { BRAND_NAME } from '../../constants.js';
import { Box, Text } from '../../ink.js';
import { useDebouncedDigitInput } from './useDebouncedDigitInput.js';
export type TranscriptShareResponse = 'yes' | 'no' | 'dont_ask_again';
type Props = {
  onSelect: (option: TranscriptShareResponse) => void;
  inputValue: string;
  setInputValue: (value: string) => void;
};
const RESPONSE_INPUTS = ['1', '2', '3'] as const;
type ResponseInput = (typeof RESPONSE_INPUTS)[number];
const inputToResponse: Record<ResponseInput, TranscriptShareResponse> = {
  '1': 'yes',
  '2': 'no',
  '3': 'dont_ask_again'
} as const;
const isValidResponseInput = (input: string): input is ResponseInput => (RESPONSE_INPUTS as readonly string[]).includes(input);
export function TranscriptSharePrompt(t0) {
  return null;
}
