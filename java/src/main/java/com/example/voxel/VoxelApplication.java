package com.example.voxel;

import com.example.voxel.service.VoxelProperties;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.scheduling.annotation.EnableScheduling;

@SpringBootApplication
@EnableScheduling
@EnableConfigurationProperties(VoxelProperties.class)
public class VoxelApplication {
    public static void main(String[] args) {
        SpringApplication.run(VoxelApplication.class, args);
    }
}
