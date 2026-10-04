// @ts-nocheck
import { createContext, type ReactNode } from 'react'
import { OrderedListItem } from './OrderedListItem.js'
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
