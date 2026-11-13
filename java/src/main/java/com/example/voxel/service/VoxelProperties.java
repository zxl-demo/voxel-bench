package com.example.voxel.service;

import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * voxel.turn-seconds / voxel.placers-max / voxel.queue-max-length
 * (env: VOXEL_TURN_SECONDS / VOXEL_PLACERS_MAX / VOXEL_QUEUE_MAX_LENGTH).
 * Defaults per SPEC v1.
 */
@ConfigurationProperties(prefix = "voxel")
public class VoxelProperties {

    private int turnSeconds = 30;
    private int placersMax = 3;
    private int queueMaxLength = 20;

    public int getTurnSeconds() {
        return turnSeconds;
    }

    public void setTurnSeconds(int turnSeconds) {
        this.turnSeconds = turnSeconds;
    }

    public int getPlacersMax() {
        return placersMax;
    }

    public void setPlacersMax(int placersMax) {
        this.placersMax = placersMax;
    }

    public int getQueueMaxLength() {
        return queueMaxLength;
    }

    public void setQueueMaxLength(int queueMaxLength) {
        this.queueMaxLength = queueMaxLength;
    }
}
