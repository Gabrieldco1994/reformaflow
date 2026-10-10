import { Injectable } from "@nestjs/common";

export const AGENT_ADMISSION_CLOCK = Symbol("AGENT_ADMISSION_CLOCK");

export interface AgentAdmissionClock {
  now(): Date;
}

@Injectable()
export class SystemAgentAdmissionClock implements AgentAdmissionClock {
  now(): Date {
    return new Date();
  }
}
