import { HttpAgentBoardApi } from './http-agent-board-api';

let singleton: HttpAgentBoardApi | undefined;

export function getAgentBoardApi() {
  singleton ??= new HttpAgentBoardApi();
  return singleton;
}

export function resetAgentBoardApi() {
  singleton = undefined;
}
