import { type Command } from '../../commands.js'
type Props = {
  commands: Command[];
  maxHeight: number;
  columns: number;
  title: string;
  onCancel: () => void;
  emptyMessage?: string;
};
export function Commands(t0) {
  return null;
}
function _temp(a, b) {
  return a.name.localeCompare(b.name);
}
