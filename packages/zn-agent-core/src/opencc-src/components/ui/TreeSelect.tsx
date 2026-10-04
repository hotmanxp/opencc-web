// @ts-nocheck
import React from 'react';
export type TreeNode<T> = {
  id: string | number;
  value: T;
  label: string;
  description?: string;
  dimDescription?: boolean;
  children?: TreeNode<T>[];
  metadata?: Record<string, unknown>;
};
export type TreeSelectProps<T> = {
  /**
   * Tree nodes to display.
   */
  readonly nodes: TreeNode<T>[];

  /**
   * Callback when a node is selected.
   */
  readonly onSelect: (node: TreeNode<T>) => void;

  /**
   * Callback when cancel is pressed.
   */
  readonly onCancel?: () => void;

  /**
   * Callback when focused node changes.
   */
  readonly onFocus?: (node: TreeNode<T>) => void;

  /**
   * Node to focus by ID.
   */
  readonly focusNodeId?: string | number;

  /**
   * Number of visible options.
   */
  readonly visibleOptionCount?: number;

  /**
   * Layout of the options.
   */
  readonly layout?: 'compact' | 'expanded' | 'compact-vertical';

  /**
   * When disabled, user input is ignored.
   */
  readonly isDisabled?: boolean;

  /**
   * When true, hides the numeric indexes next to each option.
   */
  readonly hideIndexes?: boolean;

  /**
   * Function to determine if a node should be initially expanded.
   * If not provided, all nodes start collapsed.
   */
  readonly isNodeExpanded?: (nodeId: string | number) => boolean;

  /**
   * Callback when a node is expanded.
   */
  readonly onExpand?: (nodeId: string | number) => void;

  /**
   * Callback when a node is collapsed.
   */
  readonly onCollapse?: (nodeId: string | number) => void;

  /**
   * Custom prefix function for parent nodes
   * @param isExpanded - Whether the parent node is currently expanded
   * @returns The prefix string to display (default: '▼ ' when expanded, '▶ ' when collapsed)
   */
  readonly getParentPrefix?: (isExpanded: boolean) => string;

  /**
   * Custom prefix function for child nodes
   * @param depth - The depth of the child node in the tree (0-indexed from parent)
   * @returns The prefix string to display (default: '  ▸ ')
   */
  readonly getChildPrefix?: (depth: number) => string;

  /**
   * Callback when user presses up from the first item.
   * If provided, navigation will not wrap to the last item.
   */
  readonly onUpFromFirstItem?: () => void;
};

/**
 * TreeSelect is a generic component for selecting items from a hierarchical tree structure.
 * It handles expand/collapse state, keyboard navigation, and renders the tree as a flat list
 * using the Select component.
 */
export function TreeSelect(t0) {
  return null;
}
function _temp2(_depth) {
  return "  \u25B8 ";
}
function _temp(isExpanded_0) {
  return isExpanded_0 ? "\u25BC " : "\u25B6 ";
}
