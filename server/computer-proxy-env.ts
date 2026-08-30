export function computerProxyEnv(
  computer: {
    boxId?: string;
    token?: string;
  },
): NodeJS.ProcessEnv {
  return {
    OGB_BOX_ID: computer.boxId ?? "",
    OGB_BOX_TOKEN: computer.token ?? "",
  };
}