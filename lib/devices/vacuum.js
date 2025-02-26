"use strict";

const { ChargingState, AutonomousCharging } = require("abstract-things");
const {
  Vacuum,
  AdjustableFanSpeed,
  AutonomousCleaning,
  SpotCleaning,
} = require("abstract-things/climate");

const MiioApi = require("../device");
const BatteryLevel = require("./capabilities/battery-level");
const checkResult = require("../checkResult");

/**
 * Implementation of the interface used by the Mi Robot Vacuum. This device
 * doesn't use properties via get_prop but instead has a get_status.
 */
module.exports = class extends (
  Vacuum.with(
    MiioApi,
    BatteryLevel,
    AutonomousCharging,
    AutonomousCleaning,
    SpotCleaning,
    AdjustableFanSpeed,
    ChargingState
  )
) {
  static get type() {
    return "miio:vacuum";
  }

  constructor(options) {
    super(options);

    this.defineProperty("error_code", {
      name: "error",
      mapper: (e) => {
        switch (e) {
          case 0:
            return null;
          default:
            return {
              code: e,
              message: "Unknown error " + e,
            };
        }

        // TODO: Find a list of error codes and map them correctly
      },
    });

    this.defineProperty("state", (s) => {
      switch (s) {
        case 1:
          return "initiating";
        case 2:
          return "charger-offline";
        case 3:
          return "waiting";
        case 5:
          return "cleaning";
        case 6:
          return "returning";
        case 8:
          return "charging";
        case 9:
          return "charging-error";
        case 10:
          return "paused";
        case 11:
          return "spot-cleaning";
        case 12:
          return "error";
        case 13:
          return "shutting-down";
        case 14:
          return "updating";
        case 15:
          return "docking";
        case 16:
          return "going-to-location";
        case 17:
          return "zone-cleaning";
        case 18:
          return "room-cleaning";
        case 22:
          return "dust-collection";
        case 100:
          return "full";
      }
      return "unknown-" + s;
    });

    // Define the batteryLevel property for monitoring battery
    this.defineProperty("battery", {
      name: "batteryLevel",
    });

    this.defineProperty("clean_time", {
      name: "cleanTime",
    });
    this.defineProperty("clean_area", {
      name: "cleanArea",
      mapper: (v) => v / 1000000,
    });
    this.defineProperty("fan_power", {
      name: "fanSpeed",
    });
    this.defineProperty("in_cleaning");

    // Consumable status - times for brushes and filters
    this.defineProperty("main_brush_work_time", {
      name: "mainBrushWorkTime",
    });
    this.defineProperty("side_brush_work_time", {
      name: "sideBrushWorkTime",
    });
    this.defineProperty("filter_work_time", {
      name: "filterWorkTime",
    });
    this.defineProperty("sensor_dirty_time", {
      name: "sensorDirtyTime",
    });

    this.defineProperty("water_box_mode", {
      name: "waterBoxMode",
    });

    this.defineProperty("auto_dust_collection", {
      name: "autoDustCollection",
    });
    this.defineProperty("dust_collection_status", {
      name: "dustCollectionStatus",
    });

    this._monitorInterval = 60000;
  }

  propertyUpdated(key, value, oldValue) {
    if (key === "state") {
      // Update charging state
      this.updateCharging(value === "charging");

      switch (value) {
        case "cleaning":
        case "spot-cleaning":
        case "zone-cleaning":
        case "zone-cleaning":
        case "room-cleaning":
          // The vacuum is cleaning
          this.updateCleaning(true);
          break;
        case "paused":
          // Cleaning has been paused, do nothing special
          break;
        case "error":
          // An error has occurred, rely on error mapping
          this.updateError(this.property("error"));
          break;
        case "charging-error":
          // Charging error, trigger an error
          this.updateError({
            code: "charging-error",
            message: "Error during charging",
          });
          break;
        case "charger-offline":
          // Charger is offline, trigger an error
          this.updateError({
            code: "charger-offline",
            message: "Charger is offline",
          });
          break;
        default:
          // The vacuum is not cleaning
          this.updateCleaning(false);
          break;
      }
    } else if (key === "fanSpeed") {
      this.updateFanSpeed(value);
    }

    super.propertyUpdated(key, value, oldValue);
  }

  getDeviceInfo() {
    return this.call("miIO.info");
  }

  async getSerialNumber() {
    const serial = await this.call("get_serial_number");
    return serial[0].serial_number;
  }

  getRoomMap() {
    return this.call("get_room_mapping");
  }

  cleanRooms(listOfRooms) {
    return this.call("app_segment_clean", listOfRooms, {
      refresh: ["state"],
      refreshDelay: 1000,
    }).then(checkResult);
  }

  resumeCleanRooms(listOfRooms) {
    return this.call("resume_segment_clean", listOfRooms, {
      refresh: ["state"],
      refreshDelay: 1000,
    }).then(checkResult);
  }

  /**
	 * Start cleaning at specified zones.
	 * Takes in an array of zones.
	 * Zones example: [[26234,26042,26634,26642,1],[26232,25304,27282,25804,2],[26246,24189,27296,25139,2]]
	 * Single zone example: [26234,26042,26634,26642,1]
	 * Each zone contains an array of 5 values. bottom-left-x, bottom-left-y, top-right-x, top-right-y, number of clean times.
	 * Maps are always 51200 x 51200. The charger/starting location is always the center; so 25600, 25600
	 */
  cleanZones(listOfZones) {
    return this.call("app_zoned_clean", listOfZones, {
      refresh: ["state"],
      refreshDelay: 1000,
    }).then(checkResult);
  }

  getTimer() {
    return this.call("get_timer");
  }

  /**
   * Start a cleaning session.
   */
  activateCleaning() {
    return this.call("app_start", [], {
      refresh: ["state"],
      refreshDelay: 1000,
    }).then(checkResult);
  }

  /**
   * Pause the current cleaning session.
   */
  pause() {
    return this.call("app_pause", [], {
      refresh: ["state"],
      refreshDelay: 1000, // https://github.com/homebridge-xiaomi-roborock-vacuum/homebridge-xiaomi-roborock-vacuum/issues/236
    }).then(checkResult);
  }

  /**
   * Stop the current cleaning session.
   */
  deactivateCleaning() {
    return this.call("app_stop", [], {
      refresh: ["state"],
      refreshDelay: 1000,
    }).then(checkResult);
  }

  /**
   * Stop the current cleaning session and return to charge.
   */
  activateCharging() {
    return (
      this.pause()
        .catch(() => this.deactivateCleaning())
        // Wait 1 second
        .then(() => new Promise((resolve) => setTimeout(resolve, 1000)))
        .then(() =>
          this.call("app_charge", [], {
            refresh: ["state"],
            refreshDelay: 1000,
          })
        )
        .then(checkResult)
    );
  }

  /**
   * Start cleaning the current spot.
   */
  activateSpotClean() {
    return this.call("app_spot", [], {
      refresh: ["state"],
    }).then(checkResult);
  }

  /**
   * Start dustCollection.
   */
  startDustCollection() {
    return this.call("app_start_collect_dust", [], {
      refresh: ["state"],
      refreshDelay: 1000,
    }).then(checkResult);
  }

  /**
   * Stop dustCollection.
   */
  stopDustCollection() {
    return this.call("app_stop_collect_dust", [], {
      refresh: ["state"],
      refreshDelay: 1000,
    }).then(checkResult);
  }

  /**
   * Set the power of the fan. Usually 38, 60 or 77.
   */
  changeFanSpeed(speed) {
    return this.call("set_custom_mode", [speed], {
      refresh: ["fanSpeed"],
    }).then(checkResult);
  }

  /**
   * Get WaterBoxMode (only working for the model S6)
   * @returns {Promise<*>}
   */
  async getWaterBoxMode() {
    // From https://github.com/marcelrv/XiaomiRobotVacuumProtocol/blob/master/water_box_custom_mode.md
    const response = await this.call("get_water_box_custom_mode", [], {
      refresh: ["waterBoxMode"],
    });
    return response[0];
  }

  setWaterBoxMode(mode) {
    // From https://github.com/marcelrv/XiaomiRobotVacuumProtocol/blob/master/water_box_custom_mode.md
    return this.call("set_water_box_custom_mode", [mode], {
      refresh: ["waterBoxMode"],
    }).then(checkResult);
  }

  /**
   * Activate the find function, will make the device give off a sound.
   */
  find() {
    return this.call("find_me", [""]).then(() => null);
  }

  /**
	 * Send the robot to a specified target.
	 * Takes in a single zone: [25000,25000]
	 * Maps are always 51200 x 51200. The charger/starting location is always the center; so 25600, 25600
	 */
  sendToLocation(x, y) {
    return this.call("app_goto_target", [x, y], {
      refresh: ["state"],
      refreshDelay: 1000,
    }).then(checkResult);
  }

  /**
   * Get information about the cleaning history of the device. Contains
   * information about the number of times it has been started and
   * the days it has been run.
   */
  getHistory() {
    return this.call("get_clean_summary").then((result) => {
      return {
        count: result[2],
        days: result[3].map((ts) => new Date(ts * 1000)),
      };
    });
  }

  /**
   * Get history for the specified day. The day should be fetched from
   * `getHistory`.
   */
  getHistoryForDay(day) {
    let record = day;
    if (record instanceof Date) {
      record = Math.floor(record.getTime() / 1000);
    }
    return this.call("get_clean_record", [record]).then((result) => ({
      day: day,
      history: result.map((data) => ({
        // Start and end times
        start: new Date(data[0] * 1000),
        end: new Date(data[1] * 1000),

        // How long it took in seconds
        duration: data[2],

        // Area in m2
        area: data[3] / 1000000,

        // If it was a complete run
        complete: data[5] === 1,
      })),
    }));
  }

  loadProperties(props) {
    // We override loadProperties to use get_status and get_consumables
    props = props.map((key) => this._reversePropertyDefinitions[key] || key);

    return Promise.all([
      this.call("get_status"),
      this.call("get_consumable"),
    ]).then((result) => {
      const status = result[0][0];
      const consumables = result[1][0];

      const mapped = {};
      props.forEach((prop) => {
        let value = status[prop];
        if (typeof value === "undefined") {
          value = consumables[prop];
        }
        this._pushProperty(mapped, prop, value);
      });
      return mapped;
    });
  }
};