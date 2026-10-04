// @ts-nocheck
import setWith from 'lodash-es/setWith.js';
import * as React from 'react';
import { Box, Text } from '../ink.js'
import type { ValidationError } from '../utils/settings/validation.js';
import { type TreeNode } from '../utils/treeify.js'

/**
 * Builds a nested tree structure from dot-notation paths
 * Uses lodash setWith to avoid automatic array creation
 */
function buildNestedTree(errors: ValidationError[]): TreeNode {
  const tree: TreeNode = {};
  errors.forEach(error => {
    if (!error.path) {
      // Root level error - use empty string as key
      tree[''] = error.message;
      return;
    }

    // Try to enhance the path with meaningful values
    const pathParts = error.path.split('.');
    let modifiedPath = error.path;

    // If we have an invalid value, try to make the path more readable
    if (error.invalidValue !== null && error.invalidValue !== undefined && pathParts.length > 0) {
      const newPathParts: string[] = [];
      for (let i = 0; i < pathParts.length; i++) {
        const part = pathParts[i];
        if (!part) continue;
        const numericPart = parseInt(part, 10);

        // If this is a numeric index and it's the last part where we have the invalid value
        if (!isNaN(numericPart) && i === pathParts.length - 1) {
          // Format the value for display
          let displayValue: string;
          if (typeof error.invalidValue === 'string') {
            displayValue = `"${error.invalidValue}"`;
          } else if (error.invalidValue === null) {
            displayValue = 'null';
          } else if (error.invalidValue === undefined) {
            displayValue = 'undefined';
          } else {
            displayValue = String(error.invalidValue);
          }
          newPathParts.push(displayValue);
        } else {
          // Keep other parts as-is
          newPathParts.push(part);
        }
      }
      modifiedPath = newPathParts.join('.');
    }
    setWith(tree, modifiedPath, error.message, Object);
  });
  return tree;
}

/**
 * Groups and displays validation errors using treeify with deduplication
 */
export function ValidationErrorsList(t0) {
  return null;
}
function _temp3(pair, index) {
  return <Box key={`suggestion-pair-${index}`} flexDirection="column" marginBottom={1}>{pair.suggestion && <Text dimColor={true} wrap="wrap">{pair.suggestion}</Text>}{pair.docLink && <Text dimColor={true} wrap="wrap">Learn more: {pair.docLink}</Text>}</Box>;
}
function _temp2(a, b) {
  if (!a.path && b.path) {
    return -1;
  }
  if (a.path && !b.path) {
    return 1;
  }
  return (a.path || "").localeCompare(b.path || "");
}
function _temp(acc, error) {
  const file = error.file || "(file not specified)";
  if (!acc[file]) {
    acc[file] = [];
  }
  acc[file].push(error);
  return acc;
}
