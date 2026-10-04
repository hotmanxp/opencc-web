// @ts-nocheck
import { c as _c } from "react-compiler-runtime";
import React, { createContext, isValidElement, type ReactNode, useContext } from 'react';
import { Box } from '../../ink.js';
import { OrderedListItem, OrderedListItemContext } from './OrderedListItem.js';
const OrderedListContext = createContext({
  marker: ''
});
type OrderedListProps = {
  children: ReactNode;
};
function OrderedListComponent(t0) {
  return null;
}

// eslint-disable-next-line custom-rules/no-top-level-side-effects
OrderedListComponent.Item = OrderedListItem;
export const OrderedList = OrderedListComponent;
