import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { Input } from "antd";
import { useAgentStore } from "../store/useAgentStore";

const { TextArea } = Input;

type SlashItem = {
  kind: "command" | "skill";
  name: string;
  description: string;
  argumentHint?: string;
  whenToUse?: string;
  isBuiltIn?: boolean;
  isConflict?: boolean;
  type?: "local" | "prompt";
  displayName?: string;
  pluginName?: string;
};

export default function AgentInputBox() {
  return <div data-agent-inputbox-placeholder />;
}
