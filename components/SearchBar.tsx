import { COLORS } from '@/constants/colors';
import { ICONS } from '@/constants/icons';
import { IMAGES } from '@/constants/images';
import React from 'react';
import { Image, ImageBackground, TextInput, TouchableOpacity } from 'react-native';


interface Props {
  placeholder: string;
  onChangeText?: (text: string) => void; 
}

export const SearchBar = ({ placeholder, onChangeText }: Props) => {
  return (
    <ImageBackground
      source={IMAGES.searchBar}
      style={{
        borderRadius: 40,
        overflow: "hidden",
        paddingHorizontal: 8,
        backgroundColor:"#D8DAD9"
      }}
    >
      <TouchableOpacity
        style={{
          flexDirection: "row",
          alignItems: "center",
          borderRadius: 40,
          paddingHorizontal: 12,
          paddingVertical: 8,
          height: 48,
        }}
        activeOpacity={0.8}
        accessible={true}
        accessibilityLabel="Search for a location"
      >
        {/* Search Icon */}
        <Image
          source={ICONS.search}
          resizeMode="contain"
          style={{
            tintColor: COLORS.white,
            width: 20,
            height: 20,
          }}
        />
        {/* Text Input */}
        <TextInput
          placeholder={placeholder}
          placeholderTextColor={COLORS.white}
          style={{
            flex: 1,
            marginLeft: 8,
            color: COLORS.white,
            fontSize: 17,
            textAlignVertical: "center",
            padding: 0,
            fontWeight: 500,
          }}
          onChangeText={onChangeText} 
          accessible={true}
          accessibilityLabel="Search input"

        />
      </TouchableOpacity>
    </ImageBackground>
  );
};

export default SearchBar;