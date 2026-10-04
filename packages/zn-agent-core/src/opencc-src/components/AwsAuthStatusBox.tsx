// @ts-nocheck
import React, { useEffect, useState } from 'react';
import { Link, Text } from '../ink.js'
const URL_RE = /https?:\/\/\S+/;
export function AwsAuthStatusBox() {
  return null;
}
function _temp(line, index) {
  const m = line.match(URL_RE);
  if (!m) {
    return <Text key={index} dimColor={true}>{line}</Text>;
  }
  const url = m[0];
  const start = m.index ?? 0;
  const before = line.slice(0, start);
  const after = line.slice(start + url.length);
  return <Text key={index} dimColor={true}>{before}<Link url={url}>{url}</Link>{after}</Text>;
}
