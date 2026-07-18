package com.example.cdu.dto;

import com.fasterxml.jackson.annotation.JsonProperty;
import javax.validation.constraints.NotNull;

public class CustomerResponse {
    @NotNull
    private String id;
    private String name;
    private String phone;
    @JsonProperty(required = true)
    private String email;
    
    public static final String VERSION = "1.0";
}