import "reflect-metadata";
import { ScheduleController } from "../schedule/schedule.controller";
import { FloorPlanController } from "../floor-plan/floor-plan.controller";
import { ScheduleService } from "../schedule/schedule.service";

describe("child-id routes must keep project scope context", () => {
  it("ScheduleController child-id mutations keep project scope args", () => {
    expect(ScheduleController.prototype.updateStage.length).toBeGreaterThanOrEqual(
      4,
    );
    expect(ScheduleController.prototype.deleteStage.length).toBeGreaterThanOrEqual(
      3,
    );
  });

  it("FloorPlanController child-id mutations keep project scope args", () => {
    expect(FloorPlanController.prototype.createRoom.length).toBeGreaterThanOrEqual(
      4,
    );
    expect(FloorPlanController.prototype.updateRoom.length).toBeGreaterThanOrEqual(
      4,
    );
    expect(FloorPlanController.prototype.deleteRoom.length).toBeGreaterThanOrEqual(
      3,
    );
    expect(FloorPlanController.prototype.deleteMarker.length).toBeGreaterThanOrEqual(
      3,
    );
  });

  it("ScheduleService.updateStage/deleteStage must accept project+tenant scope args", () => {
    expect(ScheduleService.prototype.updateStage.length).toBeGreaterThanOrEqual(
      4,
    );
    expect(ScheduleService.prototype.deleteStage.length).toBeGreaterThanOrEqual(
      3,
    );
  });
});
